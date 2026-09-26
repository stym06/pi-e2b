import type { Sandbox } from 'e2b'
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
export async function push(sandbox: Sandbox, cwd: string, token: string): Promise<string> {
  if (!token.trim()) throw new Error('Set E2B_GIT_TOKEN before starting Pi to push.')
  const directory = quote(cwd)
  const command = [
    `branch=$(git -C ${directory} symbolic-ref --quiet --short HEAD)`,
    'test -n "$branch"',
    `git -C ${directory} -c credential.helper= push origin "HEAD:refs/heads/$branch"`,
  ].join('\n')
  const result = await sandbox.commands.run(withAskpass(command), {
    timeoutMs: 180_000, envs: { PI_E2B_GIT_TOKEN: token },
  })
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || 'Push completed.'
}
