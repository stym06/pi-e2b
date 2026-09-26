import { Sandbox, type SandboxOpts } from 'e2b'
import { checkTools, mkdir } from './ops.ts'
import { clone, createSessionBranch } from './git.ts'

export const ENTRY_TYPE = 'pi-e2b-session'

export interface SessionRecord {
  version: 1
  sessionId: string
  sandboxId: string
  cwd: string
  home: string
  owned: boolean
  branch?: string
  killed?: boolean
}

export interface ActiveSession {
  sandbox: Sandbox
  record: SessionRecord
  persisted: boolean
}

export interface SessionOptions {
  apiKey: string
  template: string
  timeoutMs: number
  publicTraffic: boolean
  sandboxId?: string
  cwd?: string
  repo?: string
  branch?: string
  gitToken?: string
}

export interface Provider {
  create(template: string, options: SandboxOpts): Promise<Sandbox>
  connect(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Sandbox>
  fork(id: string, options: { apiKey: string; timeoutMs: number }): Promise<Array<Sandbox | Error>>
  kill(id: string, options: { apiKey: string }): Promise<boolean>
}

export class Sessions {
  active?: ActiveSession
  private connecting?: Promise<ActiveSession>

  constructor(readonly options: SessionOptions, private provider: Provider = Sandbox) {}

  async start(sessionId: string, persisted: boolean, previous?: SessionRecord): Promise<SessionRecord> {
    const opts = this.options
    const connection = { apiKey: opts.apiKey, timeoutMs: opts.timeoutMs }
    if (previous?.killed && previous.sessionId === sessionId) {
      throw new Error('This session’s sandbox was deleted. Use /e2b new to create an empty replacement.')
    }
    if (previous && previous.sessionId === sessionId) {
      // A missing or inaccessible sandbox is never silently replaced with an empty one.
      const sandbox = await this.provider.connect(previous.sandboxId, connection)
      const record = previous.branch ? previous : { ...previous, branch: await createSessionBranch(sandbox, previous.cwd, sessionId) }
      this.active = { sandbox, record, persisted }
      return record
    }

    let sandbox: Sandbox | undefined
    let owned = true
    try {
      if (previous && !previous.killed) {
        // A Pi fork must not keep writing into its parent's sandbox.
        const parent = await this.provider.connect(previous.sandboxId, connection)
        try {
          const [fork] = await this.provider.fork(previous.sandboxId, connection)
          if (!fork || fork instanceof Error) throw fork ?? new Error('E2B returned no fork')
          sandbox = fork
        } finally {
          if (previous.owned) await parent.pause()
        }
      } else if (opts.sandboxId) {
        owned = false
        sandbox = await this.provider.connect(opts.sandboxId, connection)
      } else {
        sandbox = await this.provider.create(opts.template, {
          ...connection, metadata: { 'created-by': 'pi-e2b', 'pi-session-id': sessionId },
          lifecycle: { onTimeout: persisted ? 'pause' : 'kill', autoResume: false },
          network: { allowPublicTraffic: opts.publicTraffic },
        })
      }

      const home = previous?.home ?? (await sandbox.commands.run('printf %s "$HOME"')).stdout.trim()
      if (!home.startsWith('/')) throw new Error('Could not resolve the sandbox home directory')
      const cwd = previous && !previous.killed ? previous.cwd : opts.cwd ?? `${home}/workspace`
      if (!cwd.startsWith('/')) throw new Error('--e2b-cwd must be an absolute Linux path')
      if (!previous || previous.killed) {
        if (owned && opts.repo) await clone(sandbox, opts.repo, opts.branch, cwd, opts.gitToken)
        else await mkdir(sandbox, cwd)
      }
      await checkTools(sandbox, cwd)
      const branch = await createSessionBranch(sandbox, cwd, sessionId)
      const record: SessionRecord = { version: 1, sessionId, sandboxId: sandbox.sandboxId, home, cwd, owned, branch }
      this.active = { sandbox, record, persisted }
      return record
    } catch (error) {
      if (sandbox && owned) {
        try { await sandbox.kill() } catch (cleanup) {
          throw new AggregateError([error, cleanup], `Setup failed and cleanup failed for sandbox ${sandbox.sandboxId}. Delete it from E2B's dashboard.`)
        }
      }
      throw error
    }
  }

  async ensure(): Promise<ActiveSession> {
    if (!this.active) throw new Error('E2B sandbox unavailable. Use /e2b resume or /e2b new. No command ran on your host.')
    if (this.connecting) return this.connecting
    const active = this.active
    this.connecting = (async () => {
      active.sandbox = await this.provider.connect(active.record.sandboxId, {
        apiKey: this.options.apiKey, timeoutMs: this.options.timeoutMs,
      })
      return active
    })()
    try { return await this.connecting } finally { this.connecting = undefined }
  }

  async shutdown(): Promise<void> {
    const active = this.active
    this.active = undefined
    if (!active || !active.record.owned) return
    if (active.persisted) await active.sandbox.pause()
    else await active.sandbox.kill()
  }

  async kill(record: SessionRecord): Promise<void> {
    // Static kill works for paused/missing sandboxes too; do not wake or create
    // a sandbox just to delete it. E2B returns false if already absent.
    await this.provider.kill(record.sandboxId, { apiKey: this.options.apiKey })
    this.active = undefined
  }
}

export function latestRecord(entries: readonly unknown[]): SessionRecord | undefined {
  for (const entry of [...entries].reverse()) {
    const e = entry as { type?: string; customType?: string; data?: Partial<SessionRecord> }
    if (e.type !== 'custom' || e.customType !== ENTRY_TYPE) continue
    const data = e.data
    if (data?.version !== 1 || typeof data.sessionId !== 'string' || typeof data.sandboxId !== 'string' ||
      typeof data.cwd !== 'string' || !data.cwd.startsWith('/') || typeof data.home !== 'string' ||
      !data.home.startsWith('/') || typeof data.owned !== 'boolean' ||
      (data.branch !== undefined && (typeof data.branch !== 'string' || !/^pi\/[a-f0-9]{12}$/.test(data.branch)))) {
      throw new Error('Invalid E2B session record; refusing to attach to an unknown workspace')
    }
    return data as SessionRecord
  }
}
