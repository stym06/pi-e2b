import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { repoUrl } from './util.ts'

/** Resolve credentials on the host; never send a gh credential to another Git host. */
export async function gitCredentials(pi: Pick<ExtensionAPI, 'exec'>, repository: string, explicit = process.env.E2B_GIT_TOKEN): Promise<{ token: string; source: 'E2B_GIT_TOKEN' | 'gh' } | undefined> {
  if (explicit?.trim()) return { token: explicit.trim(), source: 'E2B_GIT_TOKEN' }
  try {
    if (new URL(repoUrl(repository)).hostname !== 'github.com') return undefined
    const result = await pi.exec('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000 })
    if (result.code === 0 && result.stdout.trim()) return { token: result.stdout.trim(), source: 'gh' }
  } catch {
    // Missing gh or unavailable login leaves public cloning usable.
  }
  return undefined
}
