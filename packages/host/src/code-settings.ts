/** Deployment limits and native preference schema for repository evidence. */
import Schema from '@deepseek-ai/schemastery'
import type { CodeSettings } from './code-schema.ts'

/** Background source configuration; token values stay in the credential service. */
export const CodePolicySchema = Schema.object({
  url: Schema.string().default('https://mcpgw.knot.woa.com/gongfeng'),
  tokenRef: Schema.string().default('GONGFENG_ACCESS_TOKEN'),
  chunkChars: Schema.number().step(1).min(1000).default(24000),
  maxInputChars: Schema.number().step(1).min(2000).default(120000),
  repairAttempts: Schema.number().step(1).min(0).max(2).default(1),
  maxAttempts: Schema.number().step(1).min(1).default(3),
})
/** Persisted settings exposed through the existing native settings service. */
export const CodePreferenceSchema: Schema<CodeSettings> = Schema.object({
  enabled: Schema.boolean().required(), repository: Schema.string().required(), author: Schema.string().required(),
  branchPrefix: Schema.string().required(), validationBranch: Schema.string().required(), mainBranch: Schema.string().required(),
  checkBranchPrefix: Schema.string().default(''),
  lookbackDays: Schema.number().step(1).min(1).max(31).required(),
  intervalMinutes: Schema.number().step(1).min(5).max(1440).required(),
  retentionMonths: Schema.number().step(1).min(1).max(12).required(),
  model: Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }).required(),
})
