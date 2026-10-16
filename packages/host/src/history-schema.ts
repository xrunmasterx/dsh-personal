/** Durable external conversation records, independent of native DSH session identities. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Local identity for a conversation from an explicitly configured source. */
export type HistoryId = Branded<'PersonalHistoryId'>
/** Stable reference to a filtered source message. */
export type HistoryMessageId = Branded<'PersonalHistoryMessageId'>
const identity = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<HistoryId>(value))
const messageIdentity = z.string().min(1).transform(value => brandString<HistoryMessageId>(value))

/** Persisted settings sampled once at the start of each scan. */
export const historySettingsSchema = z.object({
  enabled: z.boolean(), codex: z.boolean(), cursor: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
  lookback: z.enum(['week', '7', '14', 'month']),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict(),
}).strict()
/** Browser-editable history preferences. */
export type HistorySettings = z.infer<typeof historySettingsSchema>

/** Filtered text retained locally and cited by analysis. */
export const historyMessageSchema = z.object({
  id: messageIdentity, at: z.iso.datetime(), role: z.enum(['user', 'assistant']),
  text: z.string(), hash: z.string(), truncated: z.boolean(),
  phase: z.enum(['progress', 'answer']).optional(),
})
/** Read-only message with source identity and explicit clipping metadata. */
export type HistoryMessage = z.infer<typeof historyMessageSchema>

/** Validated model result with unknown fields stripped; the caller checks task and evidence membership. */
export const historyAnalysisSchema = z.object({
  summary: z.string().trim().min(1),
  unclassified: z.boolean(),
  matches: z.array(z.object({
    taskId: z.uuid(), summary: z.string().trim().min(1),
    // Removing retained source material may leave an existing summary without citations.
    evidence: z.array(messageIdentity),
  }).strip()).max(30),
}).strip()
/** Source-grounded summary and independently relevant task matches. */
export type HistoryAnalysis = z.infer<typeof historyAnalysisSchema>

/** Atomic conversation record, including human rules and successfully analyzed message versions. */
export const historyRecordSchema = z.object({
  id: identity, source: z.enum(['codex', 'cursor']), sourceId: z.string(), location: z.string(),
  title: z.string(), cwd: z.string(), available: z.boolean(), revision: z.number().int(),
  messages: z.array(historyMessageSchema), analyzed: z.record(z.string(), z.string()),
  analysisChunks: z.record(z.string(), z.object({ hash: z.string(), offset: z.number().int().nonnegative() })).optional(),
  sourceError: z.string().optional(), fullHistory: z.boolean().optional(), initialComplete: z.boolean().optional(),
  initialJob: z.object({ targets: z.record(z.string(), z.string()), draft: historyAnalysisSchema.nullable() }).optional(),
  analysis: historyAnalysisSchema.nullable(), analyzedAt: z.iso.datetime().nullable(),
  model: z.string(), locked: z.boolean(), ignored: z.boolean(),
  taskIds: z.array(z.uuid()), error: z.string().nullable(), failures: z.number().int(),
  retryAt: z.number(), manualSummaryPending: z.boolean().default(false),
})
/** Retained conversation with manual associations overriding model suggestions. */
export type HistoryRecord = z.infer<typeof historyRecordSchema>
/** List projection excludes message bodies and analysis checkpoints. */
export type HistoryCard = Omit<HistoryRecord, 'messages' | 'analyzed' | 'analysisChunks' | 'initialJob'> & { firstAt: string; lastAt: string; pending: boolean; messageCount: number; progress?: { completed: number; total: number } | undefined }
/** Optimistic user correction; an empty task set can restore a session to the inbox. */
export interface HistoryRule {
  id: HistoryId
  revision: number
  taskIds: string[]
  ignored: boolean
}
/** Source read result, used only inside the Host. */
export interface HistorySourceSession {
  source: 'codex' | 'cursor'
  sourceId: string
  location: string
  title: string
  cwd: string
  messages: HistoryMessage[]
  sourceError?: string
}
/** Last observed source health; read failures do not mean an empty history. */
export interface HistorySourceStatus {
  source: 'codex' | 'cursor'
  path: string
  error: string | null
}
/** Paged inbox and task-list state. */
export interface HistoryPage {
  items: HistoryCard[]
  total: number
  pendingCount: number
  failedCount: number
  nextOffset: number | null
  running: boolean
  lastScan: string | null
  nextScan: string | null
  sources: HistorySourceStatus[]
  error: string | null
}
