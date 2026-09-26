import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { run } from '../src/commands.ts'
import { quote } from '../src/util.ts'
import { processSandbox } from './helpers.ts'

test('streams stdout and stderr and preserves nonzero exits and literal shell arguments', async () => {
  const chunks: string[] = []
  const value = "spaces ' $(false) `false`\nUnicode ✓"
  const result = await run(processSandbox(), `printf %s ${quote(value)}; echo error >&2; exit 7`, tmpdir(), { onData: b => chunks.push(b.toString()) })
  assert.equal(result.exitCode, 7)
  assert.equal(result.stdout, `${value}error\n`)
  assert.equal(chunks.join(''), result.stdout)
})

test('background descendants do not keep the foreground command open', async () => {
  const start = Date.now()
  const result = await run(processSandbox(), '(sleep 2; echo later) & echo ready', tmpdir())
  assert.equal(result.stdout, 'ready\n')
  assert.ok(Date.now() - start < 1500)
})

test('timeout kills child processes, not only the remote wrapper', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-timeout-'))
  try {
    await assert.rejects(run(processSandbox(), 'sleep 0.5; echo leaked > marker', dir, { timeout: 0.1 }), /timeout:0.1/)
    await new Promise(resolve => setTimeout(resolve, 600))
    await assert.rejects(readFile(join(dir, 'marker')), /ENOENT/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('abort kills the process group and rejects without leaking delayed side effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-abort-'))
  const controller = new AbortController()
  try {
    const task = run(processSandbox(), 'echo started; sleep 0.5; echo leaked > marker', dir, {
      signal: controller.signal, onData: () => controller.abort(),
    })
    await assert.rejects(task, /aborted/)
    await new Promise(resolve => setTimeout(resolve, 600))
    await assert.rejects(readFile(join(dir, 'marker')), /ENOENT/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('pre-aborted commands never reach the transport', async () => {
  await assert.rejects(run({} as never, 'echo unsafe', tmpdir(), { signal: AbortSignal.abort() }), /aborted/)
})
