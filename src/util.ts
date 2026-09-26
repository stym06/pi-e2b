import { posix } from 'node:path'

export function quote(value: string): string {
  if (value.includes('\0')) throw new Error('NUL bytes are not supported in shell arguments')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function remotePath(value: string, cwd: string, home: string): string {
  const path = value.startsWith('@') ? value.slice(1) : value
  if (path === '~') return home
  if (path.startsWith('~/')) return posix.resolve(home, path.slice(2))
  return posix.resolve(cwd, path)
}

export function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

export function repoUrl(input: string): string {
  let value = input.trim()
  const ssh = /^git@([^:]+):(.+)$/.exec(value)
  if (ssh) value = `https://${ssh[1]}/${ssh[2]}`
  if (/^[\w.-]+\.[a-z]+\//i.test(value)) value = `https://${value}`
  const url = new URL(value)
  if (url.protocol === 'ssh:' && url.username === 'git' && !url.password && (!url.port || url.port === '22')) {
    return `https://${url.host.replace(/:22$/, '')}${url.pathname}`
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Repository must be an HTTPS URL without embedded credentials, git@host:path, or ssh://git@host/path using the default SSH port')
  }
  return url.toString()
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
