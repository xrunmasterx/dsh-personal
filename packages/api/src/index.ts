/** Exact verified artifact download route for the Personal workbench. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@xrunmasterx/dsh-personal-host'
import type { RunId } from '@xrunmasterx/dsh-personal-host/client'

/** The route needs the business service and authenticated Connection host. */
export const inject = ['personalWorkbench', 'connection']

/**
 * Register one exact route accepting record identities, never disk paths.
 * @param ctx - Host with the authenticated connection.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/personal-workbench.status', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => Response.json({ ready: true, idle: !ctx.personalWorkbench.maintenanceBusy() },
      { headers: { 'Cache-Control': 'no-store' } }),
  }), 'Personal startup and update status')
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/personal-workbench.artifact',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const url = new URL(request.url)
          const runId = url.searchParams.get('runId')
          const artifactId = url.searchParams.get('artifactId')
          if (!runId || !artifactId) return new Response('Invalid artifact request', { status: 400 })
          try {
            // The business owner validates the UUID before looking up any files.
            const run = ctx.personalWorkbench.runtime.getRun(runId as RunId)
            const bytes = await ctx.personalWorkbench.runtime.operation(() =>
              ctx.personalWorkbench.runtime.artifact(run.id, artifactId),
            )
            const artifact = run.artifacts.find(file => file.id === artifactId)
            if (!artifact) throw new Error('Artifact is not registered')
            const extension = artifact.relativePath.endsWith('.jsonl')
              ? 'jsonl'
              : artifactId === 'report'
                ? 'md'
                : 'json'
            return new Response(new Uint8Array(bytes), {
              headers: {
                'Content-Type':
                  extension === 'md'
                    ? 'text/markdown; charset=utf-8'
                    : extension === 'jsonl'
                      ? 'application/x-ndjson'
                      : 'application/json',
                'Content-Disposition': `attachment; filename="${run.id}-${encodeURIComponent(artifactId)}.${extension}"`,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store',
              },
            })
          } catch {
            // Only registered-artifact reads reach this handler; unavailable or changed files are rejected.
            return new Response('The artifact is unavailable or failed verification', { status: 409 })
          }
        },
      }),
    'Personal workbench artifacts',
  )
}
