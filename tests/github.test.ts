import assert from 'node:assert/strict'
import test, { beforeEach, afterEach } from 'node:test'
import { setup } from '../index.ts'
import { createPullRequest, parsePullRequestArgs } from '../src/github.ts'
import { fakeProvider, harness } from './helpers.ts'

const oldKey = process.env.E2B_API_KEY, oldToken = process.env.E2B_GIT_TOKEN
beforeEach(() => {
  process.env.E2B_API_KEY = 'test-key'
  delete process.env.E2B_GIT_TOKEN
})
afterEach(() => {
  if (oldKey === undefined) delete process.env.E2B_API_KEY
  else process.env.E2B_API_KEY = oldKey
  if (oldToken === undefined) delete process.env.E2B_GIT_TOKEN
  else process.env.E2B_GIT_TOKEN = oldToken
})

function fixture() {
  const h = harness(), fake = fakeProvider(), sandbox = fake.parent.sandbox
  const state = {
    head: 'pi/session', destination: 'https://github.com/acme/project.git',
    existing: [] as Array<{ html_url: string }>, failPush: false,
  }
  const token = 'github-test-secret'
  const pushes: Array<{ command: string; envs: unknown }> = []
  const apiCalls: Array<{ url: string; options: RequestInit }> = []
  h.pi.exec = async () => ({ code: 0, stdout: token, stderr: '', killed: false })
  const run = sandbox.commands.run.bind(sandbox.commands)
  sandbox.commands.run = (async (command: string, options: any) => {
    if (command.endsWith('remote get-url --push --all origin')) return { stdout: state.destination, stderr: '', exitCode: 0 }
    if (command.endsWith('symbolic-ref --quiet --short HEAD')) return { stdout: state.head, stderr: '', exitCode: 0 }
    if (command.endsWith('log -1 --format=%B')) return { stdout: 'Fix preview access\n\nKeep private previews authenticated.\nPreserve line breaks.', stderr: '', exitCode: 0 }
    if (command.includes(' push ')) {
      if (state.failPush) throw new Error('push rejected')
      pushes.push({ command, envs: options.envs })
    }
    return run(command, options)
  }) as typeof sandbox.commands.run
  const request = (async (input, options = {}) => {
    const url = String(input)
    apiCalls.push({ url, options })
    assert.equal(options.headers && (options.headers as Record<string, string>).Authorization, `Bearer ${process.env.E2B_GIT_TOKEN || token}`)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal)
    let data: unknown
    if (options.method === 'POST') {
      assert.ok(pushes.length, 'push must succeed before creating the PR')
      data = { html_url: 'https://github.com/acme/project/pull/7' }
    } else if (new URL(url).pathname.endsWith('/pulls')) data = state.existing
    else data = { default_branch: 'main' }
    return Response.json(data, { status: options.method === 'POST' ? 201 : 200 })
  }) as typeof fetch
  return { h, fake, sandbox, state, pushes, apiCalls, request, token }
}

test('PR creation pushes sandbox commits, uses the remote default base, and preserves multiline text', async () => {
  const f = fixture()
  const result = await createPullRequest(f.h.pi, f.sandbox, '/workspace', {}, f.request)
  assert.equal(result, 'Created pull request: https://github.com/acme/project/pull/7')
  assert.equal(f.pushes.length, 1)
  assert.deepEqual(f.pushes[0].envs, { PI_E2B_GIT_TOKEN: f.token })
  assert.match(f.pushes[0].command, /https:\/\/github.com\/acme\/project.git/)
  const query = new URL(f.apiCalls[1].url).searchParams
  assert.equal(query.get('head'), 'acme:pi/session')
  assert.equal(query.get('base'), 'main')
  assert.deepEqual(JSON.parse(f.apiCalls[2].options.body as string), {
    title: 'Fix preview access', body: 'Keep private previews authenticated.\nPreserve line breaks.',
    head: 'pi/session', base: 'main', draft: false,
  })
  assert.ok(!JSON.stringify([result, f.fake.parent.calls, f.pushes.map(p => p.command)]).includes(f.token))
})

test('custom base, draft, title, and body are sent literally using the explicit token override', async () => {
  const f = fixture()
  process.env.E2B_GIT_TOKEN = 'explicit-test-token'
  f.h.pi.exec = async () => { throw new Error('gh should not be needed') }
  const body = 'First line\n\nLiteral `code` and $(command).'
  await createPullRequest(f.h.pi, f.sandbox, '/workspace', { base: 'develop', title: 'Custom title', body, draft: true }, f.request)
  assert.equal(f.apiCalls.length, 2)
  assert.deepEqual(JSON.parse(f.apiCalls[1].options.body as string), {
    base: 'develop', head: 'pi/session', title: 'Custom title', body, draft: true,
  })
  assert.deepEqual(f.pushes[0].envs, { PI_E2B_GIT_TOKEN: 'explicit-test-token' })
})

test('an existing open PR is reused after pushing updates', async () => {
  const f = fixture()
  f.state.existing = [{ html_url: 'https://github.com/acme/project/pull/5' }]
  assert.match(await createPullRequest(f.h.pi, f.sandbox, '/workspace', {}, f.request), /existing pull request: https:\/\/github.com\/acme\/project\/pull\/5/)
  assert.equal(f.pushes.length, 1)
  assert.ok(f.apiCalls.every(call => call.options.method === 'GET'))
})

test('unsupported hosts, missing credentials, and identical branches fail without pushing', async () => {
  const unsupported = fixture()
  unsupported.state.destination = 'https://gitlab.com/acme/project.git'
  await assert.rejects(createPullRequest(unsupported.h.pi, unsupported.sandbox, '/workspace', {}, unsupported.request), /require an origin push URL/)
  assert.equal(unsupported.apiCalls.length, 0)
  assert.equal(unsupported.pushes.length, 0)
  const missing = fixture()
  missing.h.pi.exec = async () => ({ code: 1, stdout: '', stderr: '', killed: false })
  await assert.rejects(createPullRequest(missing.h.pi, missing.sandbox, '/workspace', {}, missing.request), /gh auth login/)
  assert.equal(missing.apiCalls.length, 0)
  const same = fixture()
  same.state.head = 'main'
  await assert.rejects(createPullRequest(same.h.pi, same.sandbox, '/workspace', {}, same.request), /same branch/)
  assert.equal(same.pushes.length, 0)
})

test('push failures prevent PR creation and API errors are actionable without leaking the token', async () => {
  const f = fixture()
  f.state.failPush = true
  await assert.rejects(createPullRequest(f.h.pi, f.sandbox, '/workspace', {}, f.request), /push rejected/)
  assert.ok(f.apiCalls.every(call => call.options.method === 'GET'))
  const denied = (async () => Response.json({ message: `Forbidden ${f.token}` }, { status: 403 })) as typeof fetch
  await assert.rejects(createPullRequest(f.h.pi, f.sandbox, '/workspace', {}, denied), (error: Error) => {
    assert.match(error.message, /HTTP 403.*Forbidden \[redacted\]/)
    assert.doesNotMatch(error.message, /github-test-secret/)
    return true
  })
})

test('an unconfirmed creation is not automatically retried', async () => {
  const f = fixture()
  let attempts = 0
  const request = (async (url, options) => {
    if (options?.method === 'POST') { attempts++; throw new Error('timeout') }
    return f.request(url, options)
  }) as typeof fetch
  await assert.rejects(createPullRequest(f.h.pi, f.sandbox, '/workspace', {}, request), /could not be confirmed/)
  assert.equal(attempts, 1)
})

test('slash command and agent tool route to PR creation; disabled mode blocks it', async t => {
  const f = fixture()
  t.mock.method(globalThis, 'fetch', f.request)
  setup(f.h.pi, f.fake.provider)
  await f.h.handlers.get('session_start')!({}, f.h.ctx)
  await f.h.commands.get('e2b')!.handler('pr develop --draft', f.h.ctx)
  assert.match(f.h.notifications.at(-1)!, /Created pull request/)
  let posted = JSON.parse(f.apiCalls.at(-1)!.options.body as string)
  assert.equal(posted.base, 'develop')
  assert.equal(posted.draft, true)
  const result = await f.h.tools.get('e2b_create_pr')!.execute('id', { title: 'Tool title', body: 'Tool body' }, undefined, undefined, f.h.ctx)
  assert.match((result.content[0] as any).text, /Created pull request/)
  posted = JSON.parse(f.apiCalls.at(-1)!.options.body as string)
  assert.equal(posted.title, 'Tool title')
  assert.equal(posted.body, 'Tool body')
  const before = f.apiCalls.length
  f.h.flags.set('e2b', false)
  await assert.rejects(f.h.tools.get('e2b_create_pr')!.execute('id', {}, undefined, undefined, f.h.ctx), /Launch Pi with --e2b/)
  assert.equal(f.apiCalls.length, before)
})

test('PR command arguments reject unsupported or ambiguous options', () => {
  assert.deepEqual(parsePullRequestArgs([]), {})
  assert.deepEqual(parsePullRequestArgs(['--draft', 'release/v2']), { draft: true, base: 'release/v2' })
  for (const args of [['--unknown'], ['main', 'develop'], ['--draft', '--draft']]) {
    assert.throws(() => parsePullRequestArgs(args), /Usage: \/e2b pr/)
  }
})
