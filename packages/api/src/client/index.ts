/** Explicit browser assembly of the generated workbench Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import contribution from '@xrunmasterx/dsh-personal-host/remote'

export type * from '@xrunmasterx/dsh-personal-host/client'
export type {} from '@xrunmasterx/dsh-personal-host/remote'

/** The official API assembly owns the shared Remote carrier. */
export const inject = ['remote']

/**
 * Mount only this feature's generated contribution.
 * @param ctx - browser Context with the official Remote carrier.
 * @returns namespace disposer awaited by Cordis unload.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await ctx.remote.$mount(contribution)
}
