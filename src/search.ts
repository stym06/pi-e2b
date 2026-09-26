import { readFileSync } from 'node:fs'
import type { Sandbox } from 'e2b'
import type { FindToolInput, GrepToolInput } from '@earendil-works/pi-coding-agent'
import { run } from './commands.ts'
import { quote, remotePath } from './util.ts'

const script = readFileSync(new URL('./search.py', import.meta.url), 'utf8')

export async function search(
  sandbox: Sandbox, cwd: string, home: string, kind: 'find' | 'grep',
  params: FindToolInput | GrepToolInput, signal?: AbortSignal,
) {
  const limit = params.limit ?? (kind === 'find' ? 1000 : 100)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit must be a positive integer')
  if ('context' in params && params.context !== undefined && (!Number.isSafeInteger(params.context) || params.context < 0)) {
    throw new Error('context must be a non-negative integer')
  }
  const path = remotePath(params.path ?? '.', cwd, home)
  const request = { ...params, kind, limit, path }
  const result = await run(sandbox, `python3 -c ${quote(script)} ${quote(JSON.stringify(request))}`, kind === 'find' ? path : cwd, { signal })
  if (result.exitCode !== 0) throw new Error(result.stdout || result.stderr || 'Search failed')
  const output = JSON.parse(result.stdout) as { lines: string[]; limited: boolean }
  let text = output.lines.map(line => line.replace(/^\.\//, '')).join('\n')
  if (!text) text = output.limited ? '' : kind === 'find' ? 'No files found matching pattern' : 'No matches found'
  if (output.limited) text += '\n[Output limit reached (lines or 50 KB). Narrow the search or increase the line limit.]'
  return { content: [{ type: 'text' as const, text }], details: undefined }
}
