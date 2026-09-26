import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { clone, push, createSessionBranch, pushDestination } from '../src/git.ts'
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


test('session branches preserve commits and uncommitted work, and initialize empty workspaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-branch-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  try {
    const sandbox = processSandbox()
    const parent = await createSessionBranch(sandbox, dir, 'parent')
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), parent)
    git('config', 'user.name', 'Pi test')
    git('config', 'user.email', 'pi@example.test')
    await writeFile(join(dir, 'file.txt'), 'original')
    git('add', '.')
    git('commit', '-qm', 'initial')
    const commit = git('rev-parse', 'HEAD')
    await writeFile(join(dir, 'file.txt'), 'uncommitted')
    assert.equal(await createSessionBranch(sandbox, dir, 'parent'), parent)
    const child = await createSessionBranch(sandbox, dir, 'child')
    assert.notEqual(child, parent)
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), child)
    assert.equal(git('rev-parse', parent), commit)
    assert.equal(git('rev-parse', 'HEAD'), commit)
    assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), 'uncommitted')
    // An existing non-current branch must never be reset by setup.
    await assert.rejects(createSessionBranch(sandbox, dir, 'parent'))
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), child)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('push destination uses pushurl and rejects ambiguous or credential-bearing remotes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-origin-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://github.com/acme/repo.git')
    git('config', 'remote.origin.pushurl', 'https://other.example/acme/repo.git')
    assert.equal(await pushDestination(processSandbox(), dir), 'https://other.example/acme/repo.git')
    git('config', '--add', 'remote.origin.pushurl', 'https://github.com/acme/repo.git')
    await assert.rejects(pushDestination(processSandbox(), dir), /exactly one/)
    git('config', '--unset-all', 'remote.origin.pushurl')
    git('config', 'remote.origin.pushurl', 'https://secret@github.com/acme/repo.git')
    await assert.rejects(pushDestination(processSandbox(), dir), /without embedded credentials/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
