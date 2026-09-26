import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { ENTRY_TYPE, Sessions, latestRecord, type Provider, type SessionOptions } from './src/session.ts'
import { preview, registerTools } from './src/tools.ts'
import { push, pushDestination } from './src/git.ts'
import { gitCredentials } from './src/auth.ts'
import { createPullRequest, parsePullRequestArgs, type PullRequestOptions } from './src/github.ts'
import { message, positiveInteger, repoUrl } from './src/util.ts'
import { Type } from 'typebox'

export default function e2bExtension(pi: ExtensionAPI): void {
  setup(pi)
}

/** Provider injection lets the offline tests exercise the actual lifecycle handlers. */
export function setup(pi: ExtensionAPI, provider?: Provider): void {
  pi.registerFlag('e2b', { description: 'Run Pi tools inside an E2B sandbox', type: 'boolean', default: false })
  pi.registerFlag('e2b-public', { description: 'Allow public access to sandbox preview URLs', type: 'boolean', default: false })
  pi.registerFlag('e2b-no-repo', { description: 'Start with an empty workspace instead of detecting a local repository', type: 'boolean', default: false })
  for (const [name, description] of Object.entries({
    'repo': 'Repository to clone instead of local origin (HTTPS or SSH URL; alias for --e2b-repo)',
    'e2b-repo': 'HTTPS repository to clone (defaults to local origin)',
    'e2b-branch': 'Branch to clone (defaults to the local branch for a detected repository)',
    'e2b-template': 'E2B template name or ID (default: base)',
    'e2b-sandbox': 'Attach to an existing E2B sandbox ID',
    'e2b-cwd': 'Absolute sandbox working directory (default: $HOME/workspace)',
    'e2b-timeout': 'Sandbox idle timeout in seconds (default: 900)',
  })) pi.registerFlag(name, { description, type: 'string' })

  let sessions: Sessions | undefined
  let failure: string | undefined
  const enabled = () => pi.getFlag('e2b') === true
  const flag = (name: string) => {
    const value = pi.getFlag(name)
    return typeof value === 'string' && value.length ? value : undefined
  }
  const ensure = async () => {
    if (!sessions?.active) throw new Error(failure ?? 'E2B sandbox unavailable. Use /e2b resume or /e2b new. No command ran on your host.')
    return sessions.ensure()
  }
  const status = (ctx: ExtensionContext, value?: string) => ctx.ui.setStatus('e2b', value)
  registerTools(pi, enabled, ensure)
  const gitAuthStatus = async () => {
    const credentials = await gitCredentials(pi, 'https://github.com')
    return `Git authentication: ${credentials ? credentials.source === 'gh' ? 'available through local gh login (github.com)' : 'configured in local Pi process (E2B_GIT_TOKEN)' : 'unavailable; run gh auth login --hostname github.com on your host, or export E2B_GIT_TOKEN before starting Pi'}`
  }

  async function pushCurrentBranch(): Promise<string> {
    const active = await ensure()
    const destination = await pushDestination(active.sandbox, active.record.cwd)
    const credentials = await gitCredentials(pi, destination)
    if (!credentials) throw new Error('Git credentials unavailable in the local Pi process. For github.com, run gh auth login --hostname github.com in your host terminal and retry. Otherwise export E2B_GIT_TOKEN on the host, then restart Pi with --e2b --continue. Do not set credentials inside the sandbox.')
    return push(active.sandbox, active.record.cwd, credentials.token, destination)
  }

  pi.registerTool({
    name: 'e2b_git_push',
    label: 'Push Git commits',
    description: 'Push existing commits on the current sandbox branch to origin. The extension automatically uses host E2B_GIT_TOKEN or the local gh login for github.com; do not check credentials in the sandbox. Only call this after the user explicitly asks to push. This does not commit, force-push, or include uncommitted changes.',
    promptSnippet: 'Push committed sandbox changes when the user explicitly asks',
    parameters: Type.Object({}),
    async execute() {
      if (!enabled()) throw new Error('Launch Pi with --e2b to use e2b_git_push')
      return { content: [{ type: 'text', text: await pushCurrentBranch() }], details: undefined }
    },
  })

  async function openPullRequest(options: PullRequestOptions = {}): Promise<string> {
    const active = await ensure()
    return createPullRequest(pi, active.sandbox, active.record.cwd, options)
  }

  pi.registerTool({
    name: 'e2b_create_pr',
    label: 'Create GitHub pull request',
    description: 'Push committed sandbox changes and create a GitHub pull request, or return an existing open PR for the same head/base. Only call after the user explicitly requests a PR. Uses host credentials. Does not commit or force-push. Defaults to the repository default branch and latest commit message.',
    promptSnippet: 'Create a GitHub PR from committed sandbox changes when explicitly requested',
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: 'Target branch; defaults to the GitHub repository default branch' })),
      title: Type.Optional(Type.String({ description: 'PR title; defaults to the latest commit subject' })),
      body: Type.Optional(Type.String({ description: 'PR description; defaults to the latest commit body' })),
      draft: Type.Optional(Type.Boolean({ description: 'Create a draft PR' })),
    }),
    async execute(_id, options) {
      if (!enabled()) throw new Error('Launch Pi with --e2b to use e2b_create_pr')
      return { content: [{ type: 'text', text: await openPullRequest(options) }], details: undefined }
    },
  })

  async function options(ctx: ExtensionContext, existing = false): Promise<SessionOptions> {
    const apiKey = process.env.E2B_API_KEY?.trim()
    if (!apiKey) throw new Error('Set E2B_API_KEY before launching Pi with --e2b. Remote tools are blocked until configured.')
    if (!existing && flag('repo') && flag('e2b-repo')) throw new Error('Choose either --repo or --e2b-repo')
    let repo = flag('repo') ?? flag('e2b-repo')
    let branch = flag('e2b-branch')
    if (!existing && repo && pi.getFlag('e2b-no-repo')) throw new Error('Choose either --repo/--e2b-repo or --e2b-no-repo')
    const sandboxId = flag('e2b-sandbox')
    if (!existing && sandboxId && repo) throw new Error('--e2b-sandbox cannot be combined with --repo/--e2b-repo')
    if (!existing && !sandboxId && !repo && !pi.getFlag('e2b-no-repo')) {
      const origin = await pi.exec('git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin'], { timeout: 5000 }).catch(() => undefined)
      if (origin?.code === 0 && origin.stdout.trim()) {
        repo = origin.stdout.trim()
        if (!branch) {
          const head = await pi.exec('git', ['-C', ctx.cwd, 'branch', '--show-current'], { timeout: 5000 })
          if (head.code === 0) branch = head.stdout.trim() || undefined
        }
      }
    }
    if (!existing && repo) repo = repoUrl(repo)
    const timeoutMs = flag('e2b-timeout')
      ? positiveInteger(flag('e2b-timeout'), 900, '--e2b-timeout') * 1000
      : positiveInteger(process.env.E2B_TIMEOUT_MS, 900_000, 'E2B_TIMEOUT_MS')
    if (timeoutMs > 86_400_000) throw new Error('Sandbox timeout cannot exceed 24 hours (Hobby accounts are limited to 1 hour)')
    const cwd = flag('e2b-cwd')
    if (cwd && !cwd.startsWith('/')) throw new Error('--e2b-cwd must be an absolute Linux path')
    return {
      apiKey, template: flag('e2b-template') ?? process.env.E2B_TEMPLATE ?? 'base',
      timeoutMs, publicTraffic: pi.getFlag('e2b-public') === true,
      sandboxId, cwd, repo, branch,
      gitToken: !existing && !sandboxId && repo ? (await gitCredentials(pi, repo))?.token : undefined,
    }
  }

  async function start(ctx: ExtensionContext, fresh = false): Promise<void> {
    failure = 'E2B sandbox is starting. No command ran on your host.'
    status(ctx, 'e2b · connecting…')
    try {
      const previous = fresh ? undefined : latestRecord(ctx.sessionManager.getEntries())
      const config = await options(ctx, previous !== undefined && !previous.killed)
      if (fresh) config.sandboxId = undefined
      sessions = new Sessions(config, provider)
      const record = await sessions.start(ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile() !== undefined, previous)
      pi.appendEntry(ENTRY_TYPE, record)
      failure = undefined
      status(ctx, `e2b · ${record.sandboxId} · ${record.cwd}`)
      ctx.ui.notify(`E2B ready: ${record.sandboxId}\nWorkspace: ${record.cwd}\nSession branch: ${record.branch}`, 'info')
    } catch (error) {
      failure = `E2B: ${message(error)}\nRemote tools remain blocked; no command ran on your host.`
      status(ctx, 'e2b · unavailable')
      ctx.ui.notify(failure, 'error')
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    if (!enabled()) return
    // Handles both reused extension runtimes and fresh ones during session switches.
    if (sessions?.active) await sessions.shutdown()
    await start(ctx)
  })
  pi.on('session_shutdown', async (_event, ctx) => {
    try { await sessions?.shutdown() } catch (error) {
      ctx.ui.notify(`E2B cleanup failed: ${message(error)}. Check the sandbox in your E2B dashboard.`, 'warning')
    }
    status(ctx)
  })
  pi.on('before_agent_start', async event => {
    if (!enabled()) return
    const active = sessions?.active
    const where = active ? `Current working directory: ${active.record.cwd} (E2B sandbox ${active.record.sandboxId})` : 'E2B sandbox unavailable. All remote tools are blocked.'
    return {
      systemPrompt: event.systemPrompt.replace(/^Current working directory: .*$/gm, where) +
        `\n\n${where}\nThe built-in bash, read, write, edit, ls, find, and grep tools and user ! commands execute inside E2B. ` +
        'Paths refer to the sandbox. Local project context and skills may refer to host files that are not present remotely. ' +
        'No local files or uncommitted changes are uploaded. The extension creates a pi/ session branch; use it unless the user requests another branch. Git commits and pushes are not automatic. When the user explicitly asks you to push, commit the requested changes first and then call e2b_git_push. The user can also run /e2b push. ' +
        'When explicitly asked to create a pull request, commit the requested changes and call e2b_create_pr with a useful title and description. It pushes existing commits and returns the PR URL; /e2b pr [base] [--draft] provides the same workflow. ' +
        'The extension reads E2B_GIT_TOKEN on the host or automatically uses the local gh login for github.com. Credentials are used for clone/push processes and host-side GitHub API calls; they are intentionally absent from ordinary sandbox shell commands. Do not inspect, print, or set credentials in the sandbox, and do not infer missing credentials from its environment. Use e2b_git_push for pushes and report its actual result. ' +
        'Use nohup with output redirected to a sandbox log file for long-running servers; bind to 0.0.0.0 and use preview_url. ' +
        'Commands default to a 120-second timeout; set timeout explicitly for longer tasks.',
    }
  })
  pi.registerCommand('e2b', {
    description: 'E2B sandbox: status, pause, resume, push, pr [base] [--draft], url <port>, kill --yes, new',
    handler: async (args, ctx) => {
      if (!enabled()) { ctx.ui.notify('Launch Pi with --e2b first.', 'warning'); return }
      const [action = 'status', ...arguments_] = args.trim().split(/\s+/).filter(Boolean)
      const [argument] = arguments_
      try {
        if (action === 'resume') {
          if (!sessions?.active) await start(ctx)
          else { const a = await ensure(); status(ctx, `e2b · ${a.record.sandboxId} · ${a.record.cwd}`) }
        } else if (action === 'new') {
          if (sessions?.active) throw new Error('An E2B sandbox is already attached. Use /e2b kill --yes before replacing it.')
          const previous = latestRecord(ctx.sessionManager.getEntries())
          if (previous && !previous.killed) throw new Error('This session has an existing sandbox. Use /e2b resume or /e2b kill --yes before replacing it.')
          await start(ctx, true)
        } else if (action === 'kill') {
          if (argument !== '--yes') throw new Error('This permanently deletes the sandbox and all its files. Run /e2b kill --yes to confirm.')
          const record = sessions?.active?.record ?? latestRecord(ctx.sessionManager.getEntries())
          if (!record) throw new Error('No sandbox is associated with this session')
          sessions ??= new Sessions(await options(ctx, true), provider)
          await sessions.kill(record)
          pi.appendEntry(ENTRY_TYPE, { ...record, killed: true })
          failure = 'The E2B sandbox was deleted. Use /e2b new to create a workspace.'
          status(ctx, 'e2b · deleted')
          ctx.ui.notify('E2B sandbox deleted.', 'info')
        } else if (action === 'pause') {
          const active = await ensure()
          await active.sandbox.pause()
          status(ctx, `e2b · ${active.record.sandboxId} · paused`)
          ctx.ui.notify('Sandbox paused. The next tool call or /e2b resume will resume it.', 'info')
        } else if (action === 'push') {
          ctx.ui.notify(await pushCurrentBranch(), 'info')
        } else if (action === 'pr') {
          ctx.ui.notify(await openPullRequest(parsePullRequestArgs(arguments_)), 'info')
        } else if (action === 'url') {
          ctx.ui.notify(preview(await ensure(), Number(argument)), 'info')
        } else if (action === 'status') {
          const active = sessions?.active
          if (!active) throw new Error(failure ?? 'No active sandbox')
          const info = await active.sandbox.getInfo()
          ctx.ui.notify(`E2B ${info.sandboxId} · ${info.state}\nWorkspace: ${active.record.cwd}\nSession branch: ${active.record.branch}\n${await gitAuthStatus()}\nOn exit: ${active.record.owned ? active.persisted ? 'pause' : 'delete (in-memory Pi session)' : 'leave attached sandbox running'}`, 'info')
        } else throw new Error('Usage: /e2b [status|pause|resume|push|pr [base] [--draft]|url <port>|kill --yes|new]')
      } catch (error) { ctx.ui.notify(message(error), 'error') }
    },
  })
}
