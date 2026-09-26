import assert from 'node:assert/strict'
import test from 'node:test'
import { setup } from '../index.ts'
import { repoUrl } from '../src/util.ts'
import { fakeProvider, harness } from './helpers.ts'

test('repository flags override local detection and clone public HTTPS/SSH URLs without credentials', async () => {
  const oldKey = process.env.E2B_API_KEY, oldToken = process.env.E2B_GIT_TOKEN
  process.env.E2B_API_KEY = 'test-key'
  delete process.env.E2B_GIT_TOKEN
  try {
    for (const flag of ['repo', 'e2b-repo']) {
      for (const url of ['https://github.com/acme/public.git', 'git@github.com:acme/public.git', 'ssh://git@github.com/acme/public.git']) {
        const h = harness(), fake = fakeProvider()
        const hostCommands: string[] = []
        h.pi.exec = async command => {
          hostCommands.push(command)
          return { code: 1, stdout: '', stderr: 'gh unavailable', killed: false }
        }
        h.flags.set('e2b-no-repo', false)
        h.flags.set(flag, url)
        setup(h.pi, fake.provider)
        await h.handlers.get('session_start')!({}, h.ctx)
        assert.equal(h.entries.length, 1, h.notifications.join('\n'))
        assert.deepEqual(hostCommands, ['gh'])
        const clone = fake.parent.calls.find(command => command.includes(' clone '))!
        assert.match(clone, /https:\/\/github.com\/acme\/public.git/)
        assert.doesNotMatch(clone, /--branch|ssh:|git@/)
        // Repository flags must not replace an existing session workspace.
        await h.handlers.get('session_shutdown')!({}, h.ctx)
        h.flags.set(flag, 'https://github.com/acme/other.git')
        await h.handlers.get('session_start')!({}, h.ctx)
        assert.equal(fake.parent.calls.filter(command => command.includes(' clone ')).length, 1)
      }
    }
    const h = harness(), fake = fakeProvider()
    h.flags.set('e2b-no-repo', false)
    h.flags.set('repo', 'https://github.com/acme/public.git')
    h.flags.set('e2b-branch', 'dev')
    setup(h.pi, fake.provider)
    await h.handlers.get('session_start')!({}, h.ctx)
    assert.ok(fake.parent.calls.some(command => command.includes("clone --branch 'dev'")))
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
    if (oldToken === undefined) delete process.env.E2B_GIT_TOKEN
    else process.env.E2B_GIT_TOKEN = oldToken
  }
})

test('conflicting repository flags fail before creating a sandbox', async () => {
  const oldKey = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'test-key'
  try {
    for (const [flag, value] of [['e2b-repo', 'https://github.com/a/b'], ['e2b-no-repo', true], ['e2b-sandbox', 'existing']] as const) {
      const h = harness(), fake = fakeProvider()
      h.flags.set('e2b-no-repo', false)
      h.flags.set('repo', 'https://github.com/acme/public.git')
      h.flags.set(flag, value)
      setup(h.pi, fake.provider)
      await h.handlers.get('session_start')!({}, h.ctx)
      assert.equal(fake.calls.length, 0)
      assert.match(h.notifications.at(-1)!, /Choose either|cannot be combined/)
    }
  } finally {
    if (oldKey === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = oldKey
  }
})

test('SSH URL conversion accepts the default port and rejects credentials or alternate ports', () => {
  assert.equal(repoUrl('ssh://git@github.com:22/acme/repo.git'), 'https://github.com/acme/repo.git')
  for (const url of ['ssh://git:secret@github.com/acme/repo.git', 'ssh://git@github.com:2222/acme/repo.git', 'ssh://other@github.com/acme/repo.git']) {
    assert.throws(() => repoUrl(url), /Repository must/)
  }
})
