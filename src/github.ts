import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Sandbox } from 'e2b'
import { gitCredentials } from './auth.ts'
import { push, pushDestination } from './git.ts'
import { quote } from './util.ts'

export interface PullRequestOptions {
  base?: string
  title?: string
  body?: string
  draft?: boolean
}

export function parsePullRequestArgs(args: string[]): PullRequestOptions {
  const options: PullRequestOptions = {}
  for (const arg of args) {
    if (arg === '--draft' && !options.draft) options.draft = true
    else if (!arg.startsWith('-') && !options.base) options.base = arg
    else throw new Error('Usage: /e2b pr [base-branch] [--draft]')
  }
  return options
}

/** The host calls GitHub; repository inspection and pushing stay in the sandbox. */
export async function createPullRequest(
  pi: Pick<ExtensionAPI, 'exec'>, sandbox: Sandbox, cwd: string,
  options: PullRequestOptions = {}, request: typeof fetch = fetch,
): Promise<string> {
  const destination = await pushDestination(sandbox, cwd)
  const url = new URL(destination)
  const parts = url.pathname.replace(/\/$/, '').replace(/\.git$/, '').split('/').slice(1)
  if (url.hostname !== 'github.com' || url.port || url.search || url.hash || parts.length !== 2 ||
      parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('Pull requests require an origin push URL at https://github.com/owner/repo.git.')
  }
  const [owner, repo] = parts
  const credentials = await gitCredentials(pi, destination)
  if (!credentials) throw new Error('Run gh auth login --hostname github.com in your host terminal, then retry /e2b pr. Alternatively export E2B_GIT_TOKEN before starting Pi.')
  const { token } = credentials
  const endpoint = `/repos/${owner}/${repo}`
  const api = async (path: string, body?: object): Promise<any> => {
    let response: Response
    try {
      response = await request(`https://api.github.com${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10',
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(body
        ? 'GitHub PR creation could not be confirmed. Retry /e2b pr to find an existing PR before creating another.'
        : 'Could not reach GitHub. Check your connection and retry /e2b pr.')
    }
    const data = await response.json().catch(() => undefined)
    if (!response.ok) {
      const details = [data?.message, ...(Array.isArray(data?.errors) ? data.errors.map((error: any) => error?.message) : [])]
        .filter((value): value is string => typeof value === 'string').join('; ').replaceAll(token, '[redacted]').slice(0, 1000)
      throw new Error(`GitHub request failed (HTTP ${response.status})${details ? `: ${details}` : ''}. Check repository access and Pull requests: Read and write permission.`)
    }
    return data
  }
  const git = `git -C ${quote(cwd)}`
  const head = (await sandbox.commands.run(`${git} symbolic-ref --quiet --short HEAD`, { timeoutMs: 10_000 })).stdout.trim()
  if (!head) throw new Error('Check out a branch in the sandbox before creating a pull request.')
  const base = options.base?.trim() || (await api(endpoint))?.default_branch
  if (typeof base !== 'string' || !base) throw new Error('Could not determine the base branch. Use /e2b pr <base-branch>.')
  if (base === head) throw new Error('The PR head and base are the same branch. Check out a feature branch or choose another base.')

  const commit = (await sandbox.commands.run(`${git} log -1 --format=%B`, { timeoutMs: 10_000 })).stdout.trim()
  const [subject, ...description] = commit.split('\n')
  const title = options.title?.trim() || subject
  if (!title) throw new Error('Commit your changes before creating a pull request.')
  const query = new URLSearchParams({ state: 'open', head: `${owner}:${head}`, base, per_page: '1' })
  const existing = await api(`${endpoint}/pulls?${query}`)
  if (!Array.isArray(existing)) throw new Error('GitHub returned an invalid pull request list; no push was attempted.')

  await push(sandbox, cwd, token, destination)
  const pull = existing[0] ?? await api(`${endpoint}/pulls`, {
    title, body: options.body ?? description.join('\n').trim(), head, base, draft: options.draft ?? false,
  })
  const link = pull?.html_url
  if (typeof link !== 'string' || !link.toLowerCase().startsWith(`https://github.com/${owner}/${repo}/pull/`.toLowerCase()) || !/\/pull\/\d+$/.test(link)) {
    throw new Error('GitHub did not return a PR link. Check the repository pull requests before retrying.')
  }
  return `${existing.length ? 'Updated branch for existing pull request' : 'Created pull request'}: ${link}`
}
