import type { Sandbox } from 'e2b'
import type { BashOperations, ReadOperations, WriteOperations, EditOperations, LsOperations } from '@earendil-works/pi-coding-agent'
import { run } from './commands.ts'
import { quote } from './util.ts'

export function bashOps(sandbox: Sandbox, cwd: string): BashOperations {
  return { exec: (command, _cwd, options) => run(sandbox, command, cwd, options) }
}

export function readOps(sandbox: Sandbox): ReadOperations {
  // Each tool call builds fresh operations, so image detection and reading can
  // share a download without caching data across subsequent edits.
  const reads = new Map<string, Promise<Buffer>>()
  const readFile = (path: string) => {
    if (!reads.has(path)) reads.set(path, sandbox.files.read(path, { format: 'bytes' }).then(Buffer.from))
    return reads.get(path)!
  }
  return {
    readFile,
    access: async path => { await sandbox.files.getInfo(path) },
    detectImageMimeType: async path => {
      const buffer = await readFile(path)
      if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
      if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
      if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString())) return 'image/gif'
      if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
      if (buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp'
      return null
    },
  }
}

export function writeOps(sandbox: Sandbox): WriteOperations {
  return {
    writeFile: async (path, content) => { await sandbox.files.write(path, content) },
    mkdir: async path => { await sandbox.files.makeDir(path) },
  }
}

export function editOps(sandbox: Sandbox): EditOperations {
  return { ...readOps(sandbox), writeFile: writeOps(sandbox).writeFile }
}

export function lsOps(sandbox: Sandbox): LsOperations {
  return {
    exists: path => sandbox.files.exists(path),
    stat: async path => {
      const info = await sandbox.files.getInfo(path)
      return { isDirectory: () => info.type === 'dir' }
    },
    readdir: async path => (await sandbox.files.list(path)).map(entry => entry.name),
  }
}

export async function checkTools(sandbox: Sandbox, cwd: string): Promise<void> {
  // Install only a missing search dependency. Custom templates can preinstall it.
  await sandbox.commands.run('command -v rg >/dev/null || (apt-get update -qq && apt-get install -y -qq ripgrep)', {
    user: 'root', timeoutMs: 180_000,
  })
  await sandbox.commands.run('command -v python3 && command -v bash && command -v git && command -v rg', { cwd })
}

export async function mkdir(sandbox: Sandbox, cwd: string): Promise<void> {
  await sandbox.commands.run(`mkdir -p -- ${quote(cwd)}`)
}
