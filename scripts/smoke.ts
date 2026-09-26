import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent'

const dir = await mkdtemp(join(tmpdir(), 'pi-e2b-loader-'))
try {
  const result = await discoverAndLoadExtensions([fileURLToPath(new URL('../index.ts', import.meta.url))], dir, dir)
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1)
  const extension = result.extensions[0]
  assert.deepEqual([...extension.tools.keys()].sort(), ['bash', 'e2b_create_pr', 'e2b_git_push', 'edit', 'find', 'grep', 'ls', 'preview_url', 'read', 'write'])
  assert.ok(extension.flags.has('e2b'))
  assert.ok(extension.flags.has('repo'))
  assert.ok(extension.flags.has('e2b-repo'))
  assert.ok(extension.commands.has('e2b'))
  assert.ok(extension.handlers.has('user_bash'))
  assert.ok(extension.handlers.has('session_shutdown'))
  console.log('Smoke passed: Pi loaded the TypeScript extension, 10 tools, flags, commands, and lifecycle hooks.')
} finally { await rm(dir, { recursive: true, force: true }) }
