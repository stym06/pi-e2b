import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clone, push } from '../src/git.ts'
import { processSandbox } from './helpers.ts'

test('explicit push sends committed work without storing the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-git-'))
  const bare = join(dir, 'remote.git')
  const work = join(dir, 'work')
  const token = 'test-secret-never-persist'
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  try {
    git('init', '--bare', '-q', bare)
    const sandbox = processSandbox()
    git('clone', '-q', bare, work)
    git('-C', work, 'config', 'user.name', 'Pi test')
    git('-C', work, 'config', 'user.email', 'pi@example.test')
    git('-C', work, 'checkout', '-qb', 'feature')
    git('-C', work, 'commit', '--allow-empty', '-qm', 'change')
    const result = await push(sandbox, work, token)
    assert.match(result, /feature/)
    assert.equal(git('--git-dir', bare, 'rev-parse', 'refs/heads/feature'), git('-C', work, 'rev-parse', 'HEAD'))
    assert.doesNotMatch(await readFile(join(work, '.git', 'config'), 'utf8'), /test-secret-never-persist/)
    assert.equal(git('-C', work, 'remote', 'get-url', 'origin'), bare)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('push refuses missing credentials before contacting the sandbox', async () => {
  await assert.rejects(push({} as never, '/workspace', ''), /E2B_GIT_TOKEN/)
})

test('clone passes a token only in the process environment', async () => {
  let command = '', envs: Record<string, string> | undefined
  const sandbox = { commands: { run: async (text: string, opts: { envs: Record<string, string> }) => {
    command = text
    envs = opts.envs
  } } } as never
  await clone(sandbox, 'https://github.com/example/project.git', 'main', '/workspace', 'private-test-token')
  assert.equal(envs?.PI_E2B_GIT_TOKEN, 'private-test-token')
  assert.doesNotMatch(command, /private-test-token/)
  assert.match(command, /GIT_ASKPASS/)
})
