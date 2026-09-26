import assert from 'node:assert/strict'
import test from 'node:test'
import { gitCredentials } from '../src/auth.ts'
import { harness, fakeProvider } from './helpers.ts'
import { setup } from '../index.ts'

test('host gh credentials are scoped to github.com and explicit tokens take precedence', async () => {
  const h = harness()
  const calls: unknown[] = []
  h.pi.exec = async (command, args, options) => {
    calls.push([command, args, options])
    return { code: 0, stdout: 'gh-secret\n', stderr: '', killed: false }
  }
  assert.deepEqual(await gitCredentials(h.pi, 'https://github.com/acme/repo.git', 'override'), { token: 'override', source: 'E2B_GIT_TOKEN' })
  assert.equal(calls.length, 0)
  for (const url of ['https://gitlab.com/acme/repo.git', 'https://github.com.evil.test/acme/repo', 'https://evil.test/github.com/repo', 'https://github.com@evil.test/repo', 'http://github.com/acme/repo']) {
    assert.equal(await gitCredentials(h.pi, url, ''), undefined)
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(await gitCredentials(h.pi, 'git@github.com:acme/repo.git', ' '), { token: 'gh-secret', source: 'gh' })
  assert.deepEqual(calls, [['gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000 }]])
  h.pi.exec = async () => ({ code: 1, stdout: 'do-not-use', stderr: 'secret error', killed: false })
  assert.equal(await gitCredentials(h.pi, 'https://github.com/a/b', ''), undefined)
  h.pi.exec = async () => { throw new Error('not installed') }
  assert.equal(await gitCredentials(h.pi, 'https://github.com/a/b', ''), undefined)
})

test('clone and resumed pushes use gh, refresh credentials, and block other push hosts', async () => {
  const oldKey = process.env.E2B_API_KEY, oldToken = process.env.E2B_GIT_TOKEN
  process.env.E2B_API_KEY = 'test-key'
  delete process.env.E2B_GIT_TOKEN
  try {
    const h = harness(), fake = fakeProvider()
    h.flags.set('e2b-no-repo', false)
    h.flags.set('e2b-repo', 'https://github.com/acme/private.git')
    let token = 'first-gh-token', hostCalls = 0
    h.pi.exec = async () => { hostCalls++; return { code: 0, stdout: token, stderr: '', killed: false } }
    let destination = 'https://github.com/acme/private.git'
    const transferred: string[] = []
    const run = fake.parent.sandbox.commands.run.bind(fake.parent.sandbox.commands)
    fake.parent.sandbox.commands.run = (async (command: string, options: any) => {
      if (command.includes('remote get-url --push')) return { stdout: destination, stderr: '', exitCode: 0 }
      if (options?.envs?.PI_E2B_GIT_TOKEN) transferred.push(options.envs.PI_E2B_GIT_TOKEN)
      return run(command, options)
    }) as typeof fake.parent.sandbox.commands.run
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({}, h.ctx)
    assert.deepEqual(transferred, ['first-gh-token'])
    const firstBranch = (h.entries.at(-1) as any).data.branch
    assert.match(firstBranch, /^pi\/[a-f0-9]{12}$/)
    await h.handlers.get('session_shutdown')!({}, h.ctx)
    token = 'second-gh-token'
    await h.handlers.get('session_start')!({}, h.ctx)
    assert.equal((h.entries.at(-1) as any).data.branch, firstBranch)
    await h.tools.get('e2b_git_push')!.execute('id', {}, undefined, undefined, h.ctx)
    token = 'third-gh-token'
    await h.commands.get('e2b')!.handler('push', h.ctx)
    assert.deepEqual(transferred, ['first-gh-token', 'second-gh-token', 'third-gh-token'])
    destination = 'https://other.example/acme/private.git'
    const before = hostCalls
    await assert.rejects(h.tools.get('e2b_git_push')!.execute('id', {}, undefined, undefined, h.ctx), /Git credentials unavailable/)
    assert.equal(hostCalls, before)
    assert.equal(transferred.length, 3)
    assert.doesNotMatch(JSON.stringify([h.entries, h.notifications, fake.parent.calls]), /first-gh-token|second-gh-token|third-gh-token/)
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
    if (oldToken === undefined) delete process.env.E2B_GIT_TOKEN
    else process.env.E2B_GIT_TOKEN = oldToken
  }
})
