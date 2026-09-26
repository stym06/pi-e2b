import type { Sandbox } from 'e2b'
import { createHash } from 'node:crypto'
import { quote, repoUrl } from './util.ts'

/** Git sees a token only in one process environment; no persistent credential helper. */
function withAskpass(command: string): string {
  return [
    'set -eu',
    'askpass=$(mktemp)',
    'trap \'rm -f "$askpass"\' EXIT',
    `printf '%s\\n' '#!/bin/sh' 'case "$1" in *Username*) echo x-access-token ;; *) printf "%s\\n" "$PI_E2B_GIT_TOKEN" ;; esac' > "$askpass"`,
    'chmod 700 "$askpass"',
    'export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0',
    command,
  ].join('\n')
}

export async function clone(sandbox: Sandbox, input: string, branch: string | undefined, cwd: string, token?: string): Promise<void> {
  const url = repoUrl(input)
  const command = `git -c credential.helper= clone ${branch ? `--branch ${quote(branch)} ` : ''}-- ${quote(url)} ${quote(cwd)}`
  await sandbox.commands.run(withAskpass(command), {
    timeoutMs: 180_000, envs: token ? { PI_E2B_GIT_TOKEN: token } : {},
  })
}

/** Push existing commits on the current branch. Never commits or force-pushes. */
export async function push(sandbox: Sandbox, cwd: string, token: string, destination = 'origin'): Promise<string> {
  if (!token.trim()) throw new Error('Set E2B_GIT_TOKEN before starting Pi to push.')
  const directory = quote(cwd)
  const command = [
    `branch=$(git -C ${directory} symbolic-ref --quiet --short HEAD)`,
    'test -n "$branch"',
    `git -C ${directory} -c credential.helper= push ${quote(destination)} "HEAD:refs/heads/$branch"`,
  ].join('\n')
  const result = await sandbox.commands.run(withAskpass(command), {
    timeoutMs: 180_000, envs: { PI_E2B_GIT_TOKEN: token },
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || 'Push completed.'
}

/** Inspect the actual push URL, including pushurl and Git URL rewriting. */
export async function pushDestination(sandbox: Sandbox, cwd: string): Promise<string> {
  const result = await sandbox.commands.run(`git -C ${quote(cwd)} remote get-url --push --all origin`, { timeoutMs: 10_000 })
  const urls = result.stdout.trim().split(/\r?\n/)
  if (urls.length !== 1 || !urls[0]) throw new Error('Configure exactly one HTTPS push URL for origin.')
  const url = new URL(urls[0])
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The origin push URL must use HTTPS without embedded credentials.')
  return url.toString()
}

/** Each session gets a stable branch; forks derive a different name. */
export async function createSessionBranch(sandbox: Sandbox, cwd: string, sessionId: string): Promise<string> {
  const branch = `pi/${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`
  const git = `git -C ${quote(cwd)}`
  await sandbox.commands.run([
    'set -eu',
    `if ! ${git} rev-parse --git-dir >/dev/null 2>&1; then ${git} init -q; fi`,
    // Checking the current name also handles unborn branches and interrupted setup.
    `if [ "$(${git} symbolic-ref --quiet --short HEAD || true)" != ${quote(branch)} ]; then`,
    `  ${git} checkout --no-track -b ${quote(branch)}`,
    'fi',
  ].join('\n'), { timeoutMs: 10_000 })
  return branch
}
