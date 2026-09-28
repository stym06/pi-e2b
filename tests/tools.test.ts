import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup } from '../index.ts'
import { registerTools, preview } from '../src/tools.ts'
import { search } from '../src/search.ts'
import { positiveInteger, repoUrl, remotePath } from '../src/util.ts'
import { fakeProvider, harness, processSandbox } from './helpers.ts'

test('all tools and user shell fail closed when E2B is unavailable', async () => {
  const h = harness()
  registerTools(h.pi, () => true, async () => { throw new Error('sandbox unavailable') })
  for (const tool of h.tools.values()) {
    await assert.rejects(tool.execute('id', { path: '/host/file', command: 'echo unsafe', pattern: '*', port: 3000 }, undefined, undefined, h.ctx), /unavailable/)
  }
  const result = await h.handlers.get('user_bash')!({ command: 'echo unsafe' }, h.ctx)
  await assert.rejects(result.operations.exec('echo unsafe', '/host', {}), /unavailable/)
})

test('actual handlers route edits and tilde paths remotely, and switch sessions', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
    await h.tools.get('write')!.execute('id', { path: '~/hello.txt', content: 'Hello world\n' }, undefined, undefined, h.ctx)
    assert.equal(fake.parent.files.get('/home/user/hello.txt'), 'Hello world\n')
    await h.tools.get('edit')!.execute('id', { path: '~/hello.txt', edits: [{ oldText: 'world', newText: 'E2B' }] }, undefined, undefined, h.ctx)
    assert.equal(fake.parent.files.get('/home/user/hello.txt'), 'Hello E2B\n')
    fake.parent.files.set('/home/user/ambiguous.txt', 'repeat repeat')
    await assert.rejects(h.tools.get('edit')!.execute('id', { path: '~/ambiguous.txt', edits: [{ oldText: 'repeat', newText: 'changed' }] }, undefined, undefined, h.ctx), /occurrences|unique/)
    assert.equal(fake.parent.files.get('/home/user/ambiguous.txt'), 'repeat repeat')
    const read = await h.tools.get('read')!.execute('id', { path: '~/hello.txt' }, undefined, undefined, h.ctx)
    assert.equal(read.content[0].type === 'text' && read.content[0].text, 'Hello E2B\n')
    await h.handlers.get('session_shutdown')!({ reason: 'fork' }, h.ctx)
    h.setSessionId('forked-session')
    await h.handlers.get('session_start')!({ reason: 'fork' }, h.ctx)
    assert.equal((h.entries.at(-1) as any).data.sandboxId, 'sandbox-1')
    await h.tools.get('write')!.execute('id', { path: 'fork.txt', content: 'child only' }, undefined, undefined, h.ctx)
    assert.equal((h.entries.at(-1) as any).data.sandboxId, 'sandbox-fork')
    assert.equal(fake.child.files.get('/home/user/workspace/fork.txt'), 'child only')
    assert.equal(fake.parent.files.has('/home/user/workspace/fork.txt'), false)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('startup is lazy, idle time begins after the agent response, and typing resumes the sandbox', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    let terminalInput: ((data: string) => void) | undefined
    ;(h.ctx as any).hasUI = true
    ;(h.ctx.ui as any).onTerminalInput = (handler: (data: string) => void) => { terminalInput = handler; return () => { terminalInput = undefined } }
    setup(h.pi, fake.provider, 20)
    await h.handlers.get('session_start')!({}, h.ctx)
    assert.equal(fake.calls.length, 0)
    terminalInput!('h')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fake.calls.length, 0)
    await h.handlers.get('agent_start')!({}, h.ctx)
    await h.tools.get('write')!.execute('id', { path: 'hello.txt', content: 'hello' }, undefined, undefined, h.ctx)
    assert.equal(fake.calls.filter(call => call.method === 'create').length, 1)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 0)
    await h.handlers.get('agent_end')!({}, h.ctx)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 1)
    const connects = fake.calls.filter(call => call.method === 'connect').length
    terminalInput!('a')
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(fake.calls.filter(call => call.method === 'connect').length > connects)
    assert.equal(fake.calls.filter(call => call.method === 'create').length, 1)
    await h.handlers.get('session_shutdown')!({}, h.ctx)
    assert.equal(terminalInput, undefined)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('continuing a saved session stays paused at startup and reconnects on first typed text', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const original = harness(), fake = fakeProvider()
    setup(original.pi, fake.provider)
    await original.handlers.get('session_start')!({}, original.ctx)
    await original.tools.get('write')!.execute('id', { path: 'hello.txt', content: 'saved' }, undefined, undefined, original.ctx)
    await original.handlers.get('session_shutdown')!({}, original.ctx)
    const resumed = harness()
    resumed.entries.push(...original.entries)
    let terminalInput: ((data: string) => void) | undefined
    ;(resumed.ctx as any).hasUI = true
    ;(resumed.ctx.ui as any).onTerminalInput = (handler: (data: string) => void) => { terminalInput = handler; return () => {} }
    setup(resumed.pi, fake.provider)
    const before = fake.calls.length
    await resumed.handlers.get('session_start')!({}, resumed.ctx)
    assert.equal(fake.calls.length, before)
    terminalInput!('\x1b[104u')
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(fake.calls.length > before)
    assert.equal(fake.calls.filter(call => call.method === 'create').length, 1)
    await resumed.handlers.get('session_shutdown')!({}, resumed.ctx)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('idle pause waits until the agent run ends', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider, 20)
    await h.handlers.get('session_start')!({}, h.ctx)
    await h.handlers.get('agent_start')!({}, h.ctx)
    await h.tools.get('write')!.execute('id', { path: 'hello.txt', content: 'hello' }, undefined, undefined, h.ctx)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 0)
    await h.handlers.get('agent_end')!({}, h.ctx)
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 0)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 1)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('sandbox work without an agent response does not start the idle countdown', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider, 20)
    await h.handlers.get('session_start')!({}, h.ctx)
    await h.tools.get('write')!.execute('id', { path: 'hello.txt', content: 'hello' }, undefined, undefined, h.ctx)
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 0)
    await h.handlers.get('session_shutdown')!({}, h.ctx)
    assert.equal(fake.parent.calls.filter(call => call === 'pause').length, 1)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('typing during an in-flight idle pause leaves the sandbox resumed', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    let releasePause!: () => void, reportPause!: () => void
    const pauseStarted = new Promise<void>(resolve => { reportPause = resolve })
    ;(fake.parent.sandbox as any).pause = async () => {
      fake.parent.calls.push('pause')
      reportPause()
      await new Promise<void>(resolve => { releasePause = resolve })
      return true
    }
    setup(h.pi, fake.provider, 200)
    await h.handlers.get('session_start')!({}, h.ctx)
    await h.handlers.get('input')!({ source: 'interactive', text: 'first' }, h.ctx)
    await h.handlers.get('agent_start')!({}, h.ctx)
    await h.tools.get('write')!.execute('id', { path: 'hello.txt', content: 'hello' }, undefined, undefined, h.ctx)
    await h.handlers.get('agent_end')!({}, h.ctx)
    await Promise.race([pauseStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('idle pause did not begin')), 1000))])
    const connects = fake.calls.filter(call => call.method === 'connect').length
    await h.handlers.get('input')!({ source: 'interactive', text: 'next' }, h.ctx)
    releasePause()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(fake.calls.filter(call => call.method === 'connect').length > connects)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('missing credentials block tools when the sandbox is first needed', async () => {
  const oldKey = process.env.E2B_API_KEY
  delete process.env.E2B_API_KEY
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
    assert.equal(fake.calls.length, 0)
    await assert.rejects(h.tools.get('write')!.execute('id', { path: '/host/unsafe', content: 'unsafe' }, undefined, undefined, h.ctx), /E2B_API_KEY/)
    assert.match(h.notifications.at(-1)!, /E2B_API_KEY/)
  } finally { if (oldKey !== undefined) process.env.E2B_API_KEY = oldKey }
})

test('kill requires an explicit confirmation and new creates a fresh workspace', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
    await h.commands.get('e2b')!.handler('resume', h.ctx)
    const command = h.commands.get('e2b')!.handler
    await command('kill', h.ctx)
    assert.ok(!fake.calls.some(c => c.method === 'kill'))
    await command('kill --yes', h.ctx)
    assert.equal((h.entries.at(-1) as any).data.killed, true)
    await assert.rejects(h.tools.get('read')!.execute('id', { path: '/anything' }, undefined, undefined, h.ctx), /deleted/)
    await command('new', h.ctx)
    assert.equal(fake.calls.filter(c => c.method === 'create').length, 2)
    assert.equal((h.entries.at(-1) as any).data.killed, undefined)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('agent can explicitly push through the token-backed tool', async () => {
  const oldE2bKey = process.env.E2B_API_KEY
  const oldGitToken = process.env.E2B_GIT_TOKEN
  process.env.E2B_API_KEY = 'test-key'
  process.env.E2B_GIT_TOKEN = 'private-test-token'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
    const result = await h.tools.get('e2b_git_push')!.execute('id', {}, undefined, undefined, h.ctx)
    assert.equal(result.content[0].type === 'text' && result.content[0].text, 'Push completed.')
    assert.ok(fake.parent.calls.some(call => call.includes(' push ')))
    assert.ok(fake.parent.calls.every(call => !call.includes('private-test-token')))
    assert.ok(!JSON.stringify(h.entries).includes('private-test-token'))
  } finally {
    if (oldE2bKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldE2bKey
    if (oldGitToken === undefined) delete process.env.E2B_GIT_TOKEN
    else process.env.E2B_GIT_TOKEN = oldGitToken
  }
})

test('resuming a session uses host credentials for both push routes without exposing them to the agent', async () => {
  const oldKey = process.env.E2B_API_KEY
  const oldToken = process.env.E2B_GIT_TOKEN
  process.env.E2B_API_KEY = 'test-key'
  delete process.env.E2B_GIT_TOKEN
  try {
    const original = harness(), fake = fakeProvider()
    setup(original.pi, fake.provider)
    await original.handlers.get('session_start')!({}, original.ctx)
    await assert.rejects(original.tools.get('e2b_git_push')!.execute('id', {}, undefined, undefined, original.ctx), /Git credentials unavailable in the local Pi process/)
    await original.commands.get('e2b')!.handler('status', original.ctx)
    assert.match(original.notifications.at(-1)!, /Git authentication: unavailable/)
    await original.handlers.get('session_shutdown')!({}, original.ctx)

    process.env.E2B_GIT_TOKEN = 'resumed-host-token'
    const resumed = harness()
    resumed.entries.push(...original.entries)
    const pushes: Array<Record<string, string> | undefined> = []
    const run = fake.parent.sandbox.commands.run.bind(fake.parent.sandbox.commands)
    fake.parent.sandbox.commands.run = (async (command: string, options: any) => {
      if (command.includes(' push ')) pushes.push(options?.envs)
      return run(command, options)
    }) as typeof fake.parent.sandbox.commands.run
    setup(resumed.pi, fake.provider)
    await resumed.handlers.get('session_start')!({}, resumed.ctx)
    assert.equal(fake.calls.filter(call => call.method === 'create').length, 1)
    await resumed.tools.get('e2b_git_push')!.execute('id', {}, undefined, undefined, resumed.ctx)
    await resumed.commands.get('e2b')!.handler('push', resumed.ctx)
    assert.deepEqual(pushes, [
      { PI_E2B_GIT_TOKEN: 'resumed-host-token' },
      { PI_E2B_GIT_TOKEN: 'resumed-host-token' },
    ])
    await resumed.commands.get('e2b')!.handler('status', resumed.ctx)
    assert.match(resumed.notifications.at(-1)!, /Git authentication: configured in local Pi process/)
    const prompt = await resumed.handlers.get('before_agent_start')!({ systemPrompt: 'Current working directory: /host' }, resumed.ctx)
    assert.match(prompt.systemPrompt, /intentionally absent from ordinary sandbox shell commands/)
    assert.doesNotMatch(JSON.stringify([prompt, resumed.entries, resumed.notifications, fake.parent.calls]), /resumed-host-token/)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
    if (oldToken === undefined) delete process.env.E2B_GIT_TOKEN
    else process.env.E2B_GIT_TOKEN = oldToken
  }
})

test('without --e2b tools remain local and user shell is not intercepted', async () => {
  const h = harness()
  registerTools(h.pi, () => false, async () => { throw new Error('must not connect') })
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-local-'))
  try {
    await writeFile(join(dir, 'local.txt'), 'local data')
    const result = await h.tools.get('read')!.execute('id', { path: join(dir, 'local.txt') }, undefined, undefined, h.ctx)
    assert.equal(result.content[0].type === 'text' && result.content[0].text, 'local data')
    assert.equal(await h.handlers.get('user_bash')!({}, h.ctx), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('remote search handles globs, ignored files, literal patterns, limits, and errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-search-'))
  try {
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(dir, 'ignored.txt'), 'needle')
    await writeFile(join(dir, 'src', 'a.ts'), 'Needle [literal]\nneedle\nneedle\n')
    await writeFile(join(dir, 'src', 'b.ts'), 'second\n')
    const sandbox = processSandbox()
    const find = await search(sandbox, dir, dir, 'find', { pattern: 'src/**/*.ts' })
    assert.match(find.content[0].text, /src\/a.ts/)
    assert.match(find.content[0].text, /src\/b.ts/)
    const grep = await search(sandbox, dir, dir, 'grep', { pattern: '[LITERAL]', literal: true, ignoreCase: true })
    assert.match(grep.content[0].text, /Needle \[literal\]/)
    const limited = await search(sandbox, dir, dir, 'grep', { pattern: 'needle', ignoreCase: true, limit: 1 })
    assert.match(limited.content[0].text, /Output limit/)
    assert.doesNotMatch(limited.content[0].text, /ignored.txt/)
    const none = await search(sandbox, dir, dir, 'grep', { pattern: 'absent' })
    assert.equal(none.content[0].text, 'No matches found')
    await assert.rejects(search(sandbox, dir, dir, 'grep', { pattern: '[' }), /regex parse error/)
    await assert.rejects(search(sandbox, dir, dir, 'find', { pattern: '*', path: '/nonexistent-directory' }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('configuration validates inputs and previews never disclose traffic tokens', () => {
  assert.equal(repoUrl('git@github.com:acme/project.git'), 'https://github.com/acme/project.git')
  assert.throws(() => repoUrl('https://token@github.com/a/b'), /credentials/)
  assert.throws(() => repoUrl('file:///tmp/repo'), /HTTPS/)
  assert.throws(() => positiveInteger('NaN', 900, 'timeout'), /positive integer/)
  assert.equal(remotePath('~/a', '/remote/project', '/remote/home'), '/remote/home/a')
  const fake = fakeProvider()
  const text = preview({ sandbox: fake.parent.sandbox } as any, 3000)
  assert.match(text, /https:\/\/3000-sandbox-1.e2b.app/)
  assert.doesNotMatch(text, /private-token/)
  assert.throws(() => preview({ sandbox: fake.parent.sandbox } as any, 65536), /Port/)
})
