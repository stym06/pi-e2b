import { spawn } from 'node:child_process'
import { CommandExitError, type Sandbox, type CommandResult } from 'e2b'
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Provider, SessionOptions } from '../src/session.ts'

export const config: SessionOptions = {
  apiKey: 'test-key', template: 'base', timeoutMs: 900_000, publicTraffic: false,
}

/** A local process transport, used ONLY by tests, exercises the real remote scripts. */
export function processSandbox(): Sandbox {
  return {
    connect: async () => undefined,
    commands: {
      async run(command: string, options: { cwd?: string; background?: boolean; envs?: Record<string, string>; onStdout?: (s: string) => void; onStderr?: (s: string) => void }) {
        const child = spawn('/bin/bash', ['-c', command], { cwd: options.cwd, env: { ...process.env, ...options.envs } })
        let stdout = '', stderr = ''
        child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); options.onStdout?.(data.toString()) })
        child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); options.onStderr?.(data.toString()) })
        const completed = new Promise<CommandResult>((resolve, reject) => {
          child.on('error', reject)
          child.on('close', code => {
            const result = { stdout, stderr, exitCode: code ?? 137, error: undefined }
            if (result.exitCode) reject(new CommandExitError(result))
            else resolve(result)
          })
        })
        // SDK starts consuming its stream before handle.wait is called too.
        void completed.catch(() => undefined)
        if (!options.background) return completed
        return { pid: child.pid, wait: () => completed, kill: async () => child.kill('SIGKILL') }
      },
    },
  } as unknown as Sandbox
}

export function fakeSandbox(id = 'sandbox-1') {
  const calls: string[] = []
  const files = new Map<string, string>()
  const sandbox = {
    sandboxId: id, trafficAccessToken: 'private-token',
    commands: { run: async (command: string) => {
      calls.push(command)
      return { stdout: command === 'printf %s "$HOME"' ? '/home/user' : command.includes('remote get-url --push --all origin') ? 'https://github.com/example/project.git\n' : '', stderr: '', exitCode: 0 }
    } },
    files: {
      getInfo: async (path: string) => {
        if (!files.has(path)) throw new Error(`Missing ${path}`)
        return { type: 'file', path }
      },
      read: async (path: string) => {
        if (!files.has(path)) throw new Error(`Missing ${path}`)
        return Buffer.from(files.get(path)!)
      },
      write: async (path: string, content: string) => { files.set(path, content) },
      makeDir: async () => true,
      exists: async (path: string) => files.has(path),
      list: async () => [...files.keys()].map(path => ({ name: path.split('/').pop() })),
    },
    pause: async () => { calls.push('pause'); return true },
    kill: async () => { calls.push('kill'); return true },
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    getInfo: async () => ({ sandboxId: id, state: 'running' }),
  } as unknown as Sandbox
  return { sandbox, calls, files }
}

export function fakeProvider() {
  const parent = fakeSandbox()
  const child = fakeSandbox('sandbox-fork')
  const calls: Array<{ method: string; args: unknown[] }> = []
  const provider: Provider = {
    create: async (...args) => { calls.push({ method: 'create', args }); return parent.sandbox },
    connect: async (...args) => { calls.push({ method: 'connect', args }); return args[0] === 'sandbox-fork' ? child.sandbox : parent.sandbox },
    fork: async (...args) => { calls.push({ method: 'fork', args }); return [child.sandbox] },
    kill: async (...args) => { calls.push({ method: 'kill', args }); return true },
  }
  return { provider, parent, child, calls }
}

export function harness() {
  const tools = new Map<string, ToolDefinition<any, any, any>>()
  const handlers = new Map<string, (...args: any[]) => any>()
  const commands = new Map<string, { handler: (...args: any[]) => any }>()
  const flags = new Map<string, string | boolean>([['e2b', true], ['e2b-no-repo', true]])
  const entries: unknown[] = []
  const notifications: string[] = []
  let sessionId = 'session-1'
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    registerFlag: () => {},
    getFlag: (key: string) => flags.get(key),
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, cmd: { handler: (...args: any[]) => any }) => commands.set(name, cmd),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }),
    exec: async () => ({ code: 1, stdout: '', stderr: '', killed: false }),
  } as unknown as ExtensionAPI
  const ctx = {
    cwd: '/host/project', hasUI: false,
    ui: { setStatus: () => {}, notify: (s: string) => notifications.push(s) },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/session.jsonl', getEntries: () => entries },
  } as unknown as ExtensionContext
  return { pi, ctx, tools, handlers, commands, flags, entries, notifications, setSessionId: (value: string) => { sessionId = value } }
}
