import assert from 'node:assert/strict'
import test from 'node:test'
import { Sessions, latestRecord, ENTRY_TYPE } from '../src/session.ts'
import { config, fakeProvider } from './helpers.ts'

test('saved sessions create private auto-pausing sandboxes, then pause on exit', async () => {
  const fake = fakeProvider()
  const sessions = new Sessions(config, fake.provider)
  const record = await sessions.start('session-a', true)
  assert.equal(record.cwd, '/home/user/workspace')
  assert.equal(record.sessionId, 'session-a')
  assert.deepEqual((fake.calls[0].args[1] as any).lifecycle, { onTimeout: 'pause', autoResume: false })
  assert.deepEqual((fake.calls[0].args[1] as any).network, { allowPublicTraffic: false })
  assert.ok(!JSON.stringify(record).includes(config.apiKey))
  await sessions.shutdown()
  assert.equal(fake.parent.calls.at(-1), 'pause')
  assert.equal(sessions.active, undefined)
})

test('resume reconnects and a Pi fork copies into a different sandbox', async () => {
  const fake = fakeProvider()
  const first = new Sessions(config, fake.provider)
  const record = await first.start('parent-session', true)
  await first.shutdown()
  const resumed = new Sessions(config, fake.provider)
  assert.deepEqual(await resumed.start('parent-session', true, record), record)
  assert.equal(fake.calls.filter(c => c.method === 'create').length, 1)
  const fork = new Sessions(config, fake.provider)
  const forkRecord = await fork.start('child-session', true, record)
  assert.equal(forkRecord.sandboxId, 'sandbox-fork')
  assert.equal(forkRecord.cwd, record.cwd)
  assert.notEqual(forkRecord.branch, record.branch)
  assert.equal(fake.parent.calls.at(-1), 'pause')
})

test('connection errors do not create duplicate or empty replacement sandboxes', async () => {
  const fake = fakeProvider()
  const s = new Sessions(config, fake.provider)
  const record = await s.start('session-a', true)
  fake.provider.connect = async () => { throw new Error('503 unavailable') }
  const resumed = new Sessions(config, fake.provider)
  await assert.rejects(resumed.start('session-a', true, record), /503/)
  assert.equal(fake.calls.filter(c => c.method === 'create').length, 1)
  assert.equal(resumed.active, undefined)
})

test('in-memory sandboxes are killed, borrowed sandboxes are left alone', async () => {
  const fake = fakeProvider()
  const ephemeral = new Sessions(config, fake.provider)
  await ephemeral.start('temporary', false)
  assert.equal((fake.calls[0].args[1] as any).lifecycle.onTimeout, 'kill')
  await ephemeral.shutdown()
  assert.equal(fake.parent.calls.at(-1), 'kill')
  fake.parent.calls.length = 0
  const attached = new Sessions({ ...config, sandboxId: 'sandbox-1' }, fake.provider)
  const record = await attached.start('attached', true)
  assert.equal(record.owned, false)
  await attached.shutdown()
  assert.ok(!fake.parent.calls.includes('kill'))
  assert.ok(!fake.parent.calls.includes('pause'))
})

test('failed setup cleans up the newly created sandbox', async () => {
  const fake = fakeProvider()
  fake.parent.sandbox.commands.run = (async () => { throw new Error('setup failed') }) as any
  await assert.rejects(new Sessions(config, fake.provider).start('session', true), /setup failed/)
  assert.equal(fake.parent.calls.at(-1), 'kill')
})

test('simultaneous tool calls share a reconnect request', async () => {
  const fake = fakeProvider()
  const sessions = new Sessions(config, fake.provider)
  await sessions.start('session', true)
  await Promise.all([sessions.ensure(), sessions.ensure(), sessions.ensure()])
  assert.equal(fake.calls.filter(c => c.method === 'connect').length, 1)
})

test('idle pause waits for active sandbox work and reconnects the same workspace', async () => {
  const fake = fakeProvider()
  const sessions = new Sessions(config, fake.provider)
  await sessions.start('session', true)
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const operation = sessions.use(async () => { await held })
  await new Promise(resolve => setImmediate(resolve))
  const pausing = sessions.pause()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 0)
  finish()
  await operation
  await pausing
  assert.equal(sessions.isPaused, true)
  await sessions.use(async () => undefined)
  assert.equal(sessions.isPaused, false)
  assert.equal(fake.calls.filter(call => call.method === 'create').length, 1)
})

test('automatic pause leaves borrowed sandboxes alone but explicit pause still works', async () => {
  const fake = fakeProvider()
  const sessions = new Sessions({ ...config, sandboxId: 'sandbox-1' }, fake.provider)
  await sessions.start('borrowed', true)
  await sessions.pause()
  assert.equal(fake.parent.calls.includes('pause'), false)
  await sessions.pause(true)
  assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 1)
})

test('session records validate their shape and honor deletion tombstones', () => {
  assert.equal(latestRecord([]), undefined)
  assert.throws(() => latestRecord([{ type: 'custom', customType: ENTRY_TYPE, data: { version: 0 } }]), /Invalid/)
})

test('deleting a saved sandbox works without reconnecting and prevents automatic recreation', async () => {
  const fake = fakeProvider()
  const sessions = new Sessions(config, fake.provider)
  const record = await sessions.start('session', true)
  fake.provider.connect = async () => { throw new Error('must not connect') }
  await sessions.kill(record)
  assert.equal(fake.calls.at(-1)?.method, 'kill')
  assert.equal(sessions.active, undefined)
  await assert.rejects(sessions.start('session', true, { ...record, killed: true }), /deleted/)
  assert.equal(fake.calls.filter(c => c.method === 'create').length, 1)
})


test('older sessions receive a branch once when resumed', async () => {
  const fake = fakeProvider()
  const first = new Sessions(config, fake.provider)
  const record = await first.start('old-session', true)
  delete record.branch
  await first.shutdown()
  fake.parent.calls.length = 0
  const resumed = new Sessions(config, fake.provider)
  const updated = await resumed.start('old-session', true, record)
  assert.match(updated.branch!, /^pi\/[a-f0-9]{12}$/)
  assert.equal(fake.parent.calls.filter(call => call.includes('checkout --no-track -b')).length, 1)
  await resumed.shutdown()
  await resumed.start('old-session', true, updated)
  assert.equal(fake.parent.calls.filter(call => call.includes('checkout --no-track -b')).length, 1)
})
