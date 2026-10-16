/** Live model preference for tool-free task editing, independent of Agent selection. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'
import type { Config } from './config.ts'

/** Atomic provider/model preference persisted by the native settings service. */
export interface BriefSettings {
  /** Exact registered LLM route. */
  model: { provider: string; model: string }
}

const schema: Schema<BriefSettings> = Schema.object({
  model: Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }).required(),
})

/**
 * Bind the user preference to the plugin lifetime; sample it once per call.
 * @param ctx - owning Host context.
 * @param base - deployment route and bounded editing policy.
 * @returns getter resolving the latest preference over the deployment policy.
 */
export function installBriefSettings(ctx: Context, base: Config['briefPolish']): () => Config['briefPolish'] {
  const initial: BriefSettings = { model: { provider: base.provider, model: base.model } }
  let source = () => initial
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, 'personal-workbench-polish', schema, initial, {
      setSource: (current) => { source = current },
      onChange: () => {},
    })
  })
  return () => ({ ...base, ...source().model })
}
