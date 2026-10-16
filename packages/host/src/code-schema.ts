/** Durable code evidence shared by background collection, task readers and retrospectives. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Repository-qualified commit identity. */
export type CodeId = Branded<'PersonalCodeId'>
/** Validated settings; credentials never enter browser preferences. */
export const codeSettingsSchema = z.object({
  enabled: z.boolean(), repository: z.string(), author: z.string().trim().min(1),
  branchPrefix: z.string().trim().min(1), validationBranch: z.string().trim().min(1), mainBranch: z.string().trim().min(1),
  checkBranchPrefix: z.string().trim().default(''),
  lookbackDays: z.number().int().min(1).max(31),
  intervalMinutes: z.number().int().min(5).max(1440), retentionMonths: z.number().int().min(1).max(12),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
})
/** Native settings value for code synchronization. */
export type CodeSettings = z.infer<typeof codeSettingsSchema>
/** Source-grounded analysis; matching a task never implies that the entire task is complete. */
export const codeAnalysisSchema = z.object({
  summary: z.string().trim().min(1),
  matches: z.array(z.object({ taskId: z.uuid(), summary: z.string().trim().min(1) })),
})
/** Persisted analysis output. */
export type CodeAnalysis = z.infer<typeof codeAnalysisSchema>
/** Retained commit and exact input chunks; successful chunk results survive process restarts. */
export const codeRecordSchema = z.object({
  id: z.string().transform(value => brandString<CodeId>(value)), project: z.string(), sha: z.string(),
  title: z.string(), message: z.string(), author: z.string(), committedAt: z.string(), discoveredAt: z.string(), url: z.string(),
  branches: z.array(z.string()), stage: z.enum(['development', 'validation', 'main']),
  stageEvents: z.array(z.object({ stage: z.enum(['development', 'validation', 'main']), observedAt: z.string() })),
  sourceSha: z.string().nullable(), patchHash: z.string().nullable(), equivalentTo: z.string().nullable(),
  diff: z.string().nullable(), diffExpired: z.boolean(), chunks: z.array(codeAnalysisSchema),
  analysis: codeAnalysisSchema.nullable(), analyzedAt: z.string().nullable(),
  error: z.string().nullable(), attempts: z.number().int().nonnegative(),
})
/** Code evidence retained separately from conversations and user-authored task descriptions. */
export type CodeRecord = z.infer<typeof codeRecordSchema>
/** Bounded archive result; reading never runs a model. */
export interface CodePage {
  items: (Omit<CodeRecord, 'diff' | 'chunks'> & { commits: Omit<CodeRecord, 'diff' | 'chunks'>[] })[]
  nextOffset: number | null
  total: number
  running: boolean
  lastScan: string | null
  error: string | null
}
