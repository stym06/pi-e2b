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
    assert.equal((h.entries.at(-1) as any).data.sandboxId, 'sandbox-fork')
    await h.tools.get('write')!.execute('id', { path: 'fork.txt', content: 'child only' }, undefined, undefined, h.ctx)
    assert.equal(fake.child.files.get('/home/user/workspace/fork.txt'), 'child only')
    assert.equal(fake.parent.files.has('/home/user/workspace/fork.txt'), false)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('missing credentials block tools and issue an actionable startup error', async () => {
  const oldKey = process.env.E2B_API_KEY
  delete process.env.E2B_API_KEY
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
    assert.equal(fake.calls.length, 0)
    assert.match(h.notifications.at(-1)!, /E2B_API_KEY/)
    await assert.rejects(h.tools.get('write')!.execute('id', { path: '/host/unsafe', content: 'unsafe' }, undefined, undefined, h.ctx), /E2B_API_KEY/)
  } finally { if (oldKey !== undefined) process.env.E2B_API_KEY = oldKey }
})

test('kill requires an explicit confirmation and new creates a fresh workspace', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    const h = harness(), fake = fakeProvider()
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({ reason: 'startup' }, h.ctx)
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
    assert.ok(fake.parent.calls.some(call => call.includes('push origin')))
    assert.ok(fake.parent.calls.every(call => !call.includes('private-test-token')))
    assert.ok(!JSON.stringify(h.entries).includes('private-test-token'))
  } finally {
    if (oldE2bKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldE2bKey
    if (oldGitToken === undefined) delete process.env.E2B_GIT_TOKEN
    else process.env.E2B_GIT_TOKEN = oldGitToken
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
