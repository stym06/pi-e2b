import {
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createLsToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type, type TSchema } from 'typebox'
import { bashOps, readOps, writeOps, editOps, lsOps } from './ops.ts'
import { search } from './search.ts'
import type { ActiveSession } from './session.ts'
import { remotePath } from './util.ts'

export function preview(active: ActiveSession, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535')
  const url = `https://${active.sandbox.getHost(port)}`
  const access = active.sandbox.trafficAccessToken
    ? '\nAccess requires the e2b-traffic-access-token header. Retrieve the token through the E2B SDK; it is not included in agent messages. For browser previews, create a sandbox with --e2b-public.'
    : '\nThis URL is publicly accessible to anyone who knows it.'
  return `${url}${access}\nThe server must listen on 0.0.0.0:${port}.`
}

export function registerTools(pi: ExtensionAPI, enabled: () => boolean, withActive: <T>(ctx: ExtensionContext, operation: (active: ActiveSession) => Promise<T>) => Promise<T>): void {
  function wrap<P extends TSchema, D, S>(
    local: ToolDefinition<P, D, S>, makeRemote: (active: ActiveSession) => ToolDefinition<P, D, S>,
  ): void {
    pi.registerTool({
      ...local,
      async execute(id, params, signal, onUpdate, ctx) {
        if (!enabled()) return local.execute(id, params, signal, onUpdate, ctx)
        if (signal?.aborted) throw new Error('aborted')
        return withActive(ctx, async active => {
          const { cwd, home } = active.record
          // Pi factories prefer ctx.cwd over their constructor cwd. Resolve ~
          // before calling them too, so they never expand to the host home.
          const args = { ...params } as Record<string, unknown>
          if (typeof args.path === 'string') args.path = remotePath(args.path, cwd, home)
          return makeRemote(active).execute(id, args as typeof params, signal, onUpdate, { ...ctx, cwd })
        })
      },
    })
  }
  const cwd = process.cwd()
  wrap(createBashToolDefinition(cwd), a => createBashToolDefinition(a.record.cwd, { operations: bashOps(a.sandbox, a.record.cwd) }))
  wrap(createReadToolDefinition(cwd), a => createReadToolDefinition(a.record.cwd, { operations: readOps(a.sandbox) }))
  wrap(createWriteToolDefinition(cwd), a => createWriteToolDefinition(a.record.cwd, { operations: writeOps(a.sandbox) }))
  wrap(createEditToolDefinition(cwd), a => createEditToolDefinition(a.record.cwd, { operations: editOps(a.sandbox) }))
  wrap(createLsToolDefinition(cwd), a => createLsToolDefinition(a.record.cwd, { operations: lsOps(a.sandbox) }))

  const find = createFindToolDefinition(cwd)
  const grep = createGrepToolDefinition(cwd)
  // Pi's grep operations do not replace its local ripgrep process; execute
  // both searches remotely and bound output before it crosses the network.
  for (const tool of [find, grep]) {
    pi.registerTool({
      ...tool,
      async execute(id, params, signal, onUpdate, ctx) {
        if (!enabled()) return tool.execute(id, params, signal, onUpdate, ctx)
        if (signal?.aborted) throw new Error('aborted')
        return withActive(ctx, async a => search(a.sandbox, a.record.cwd, a.record.home, tool.name as 'find' | 'grep', params, signal))
      },
    })
  }
  pi.registerTool({
    name: 'preview_url', label: 'Preview URL',
    description: 'Get an E2B sandbox service URL. Bind the server to 0.0.0.0; use --e2b-public for browser-accessible previews.',
    promptSnippet: 'Get a URL for a service running inside the E2B sandbox',
    parameters: Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) }),
    async execute(_id, { port }, _signal, _onUpdate, ctx) {
      if (!enabled()) throw new Error('Launch Pi with --e2b to use preview_url')
      return withActive(ctx, async active => ({ content: [{ type: 'text' as const, text: preview(active, port) }], details: undefined }))
    },
  })
  pi.on('user_bash', (_event, ctx) => {
    if (!enabled()) return
    return {
      operations: {
        async exec(command, _cwd, options) {
          if (options.signal?.aborted) throw new Error('aborted')
          return withActive(ctx, async a => bashOps(a.sandbox, a.record.cwd).exec(command, a.record.cwd, options))
        },
      },
    }
  })
}
