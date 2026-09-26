import { readFileSync } from 'node:fs'
import { CommandExitError, type Sandbox } from 'e2b'
import { quote } from './util.ts'

const runner = readFileSync(new URL('./runner.py', import.meta.url), 'utf8')

export interface RunOptions {
  signal?: AbortSignal
  timeout?: number
  onData?: (chunk: Buffer) => void
}

/** Never forward the host environment and never replay a failed command. */
export async function run(sandbox: Sandbox, command: string, cwd: string, options: RunOptions = {}) {
  if (options.signal?.aborted) throw new Error('aborted')
  const timeout = options.timeout ?? 120
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Command timeout must be positive')
  // connect extends a lease without shortening its existing expiry. Keep a
  // long command from being auto-paused halfway through its requested timeout.
  await sandbox.connect({ timeoutMs: Math.ceil(timeout * 1000) + 30_000 })
  if (options.signal?.aborted) throw new Error('aborted')
  const handle = await sandbox.commands.run(
    `exec python3 -u -c ${quote(runner)} ${quote(command)} ${quote(String(timeout))}`,
    {
      cwd, background: true, timeoutMs: 0,
      onStdout: data => options.onData?.(Buffer.from(data)),
      onStderr: data => options.onData?.(Buffer.from(data)),
    },
  )
  let cancellation: Promise<unknown> | undefined
  const abort = () => {
    // SIGKILL on only the wrapper would leave descendants running. SIGTERM
    // lets the wrapper kill the whole shell process group first.
    cancellation ??= sandbox.commands.run(`kill -TERM -- ${handle.pid}`, { timeoutMs: 10_000 })
      .catch(() => handle.kill()).catch(() => undefined)
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    const result = await handle.wait().catch((error: unknown) => {
      if (error instanceof CommandExitError) return error
      throw error
    })
    if (options.signal?.aborted) throw new Error('aborted')
    if (result.exitCode === 124) throw new Error(`timeout:${timeout}`)
    return result
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await cancellation
  }
}
