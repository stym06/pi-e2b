import assert from 'node:assert/strict'
import { Sandbox } from 'e2b'
import { Sessions } from '../src/session.ts'
import { run } from '../src/commands.ts'
import { readOps, writeOps, editOps } from '../src/ops.ts'
import { search } from '../src/search.ts'
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent'

const apiKey = process.env.E2B_API_KEY
if (!apiKey) throw new Error('Set E2B_API_KEY to run the live test. It creates a billable sandbox and deletes it afterwards.')

const sessions = new Sessions({
  apiKey, template: process.env.E2B_TEMPLATE ?? 'base', timeoutMs: 300_000, publicTraffic: false,
})
let id: string | undefined
let forkId: string | undefined
try {
  const record = await sessions.start(`pi-e2b-live-${Date.now()}`, true)
  id = record.sandboxId
  let sandbox = sessions.active!.sandbox
  const path = `${record.cwd}/test.txt`
  await writeOps(sandbox).writeFile(path, 'hello E2B\n')
  assert.equal((await readOps(sandbox).readFile(path)).toString(), 'hello E2B\n')
  const edit = createEditToolDefinition(record.cwd, { operations: editOps(sandbox) })
  await edit.execute('live', { path, edits: [{ oldText: 'hello', newText: 'goodbye' }] }, undefined, undefined, { cwd: record.cwd } as never)
  assert.equal((await readOps(sandbox).readFile(path)).toString(), 'goodbye E2B\n')
  assert.equal((await run(sandbox, 'printf test; exit 7', record.cwd)).exitCode, 7)
  const found = await search(sandbox, record.cwd, record.home, 'grep', { pattern: 'goodbye' })
  assert.match(found.content[0].text, /goodbye/)
  const controller = new AbortController()
  const command = run(sandbox, 'echo started; sleep 10; touch should-not-exist', record.cwd, {
    signal: controller.signal, onData: () => controller.abort(),
  })
  await assert.rejects(command, /aborted/)
  const background = await run(sandbox, 'sleep 5 & echo ready', record.cwd, { timeout: 2 })
  assert.match(background.stdout, /ready/)
  await sessions.shutdown()
  sandbox = await Sandbox.connect(id, { apiKey, timeoutMs: 300_000 })
  assert.equal((await readOps(sandbox).readFile(path)).toString(), 'goodbye E2B\n')
  const [fork] = await Sandbox.fork(id, { apiKey, timeoutMs: 300_000 })
  if (!fork || fork instanceof Error) throw fork ?? new Error('Fork missing')
  forkId = fork.sandboxId
  assert.equal(await fork.files.read(path), 'goodbye E2B\n')
  await fork.files.write(path, 'fork only')
  assert.equal(await sandbox.files.read(path), 'goodbye E2B\n')
  console.log('Live checks passed: files, exact edits, bash, cancellation, background commands, search, pause/resume, and fork isolation.')
} finally {
  const ids = [forkId, id].filter((value): value is string => !!value)
  const results = await Promise.allSettled(ids.map(value => Sandbox.kill(value, { apiKey })))
  const failed = results.flatMap((result, i) => result.status === 'rejected' ? [ids[i]] : [])
  if (failed.length) throw new Error(`Cleanup failed; delete these sandboxes from E2B: ${failed.join(', ')}`)
}
