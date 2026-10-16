/** Dated activities and human corrections, independent of task completion state. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import Schema from '@deepseek-ai/schemastery'
import type { JournalId } from './journal.ts'

const taskId = z.uuid().transform(value => brandString<JournalId>(value))

/** Stable identity of a retained review activity. */
export type ReviewId = Branded<'PersonalReviewId'>
/** Identity of a source message, receipt or commit observation. */
export type ReviewSourceId = Branded<'PersonalReviewSourceId'>
/** Activity identity parser for persisted and wire values. */
export const reviewIdSchema = z.string().min(1).transform(v => brandString<ReviewId>(v))
/** Evidence identity parser for persisted and wire values. */
export const reviewSourceIdSchema = z.string().min(1).transform(v => brandString<ReviewSourceId>(v))
/** Real calendar dates, without an implicit timezone conversion. */
export const reviewDaySchema = z.iso.date()
/** Descriptive work categories, independent of task status. */
export const reviewTags = z.enum(['development', 'debug', 'learning', 'performance', 'discussion', 'other'])
/** Immutable evidence snapshot retained with published reviews. */
export const reviewSourceSchema = z.object({
  id: reviewSourceIdSchema, day: reviewDaySchema, at: z.string(),
  kind: z.enum(['codex', 'cursor', 'journal', 'code']), label: z.string(), text: z.string(),
  role: z.string(), taskIds: z.array(taskId), url: z.string().optional(),
})
/** Exact retained evidence; occurrence day is separate from collection time. */
export type ReviewSource = z.infer<typeof reviewSourceSchema>
/** Grounded daily or weekly activity returned by the model. */
export const reviewActivitySchema = z.object({
  id: reviewIdSchema, day: reviewDaySchema, title: z.string().trim().min(1), markdown: z.string().trim().min(1),
  tags: z.array(reviewTags), taskIds: z.array(taskId), evidence: z.array(reviewSourceIdSchema),
})
/** One readable activity; tags describe work, never its completion status. */
export type ReviewActivity = z.infer<typeof reviewActivitySchema>
/** Model response parser; source membership is checked by the caller. */
export const reviewResultSchema = z.object({ activities: z.array(reviewActivitySchema) })
/** Human edits require the revision the editor actually displayed. */
export const reviewEditSchema = z.object({
  id: reviewIdSchema, expectedRevision: z.number().int().nonnegative(),
  activity: reviewActivitySchema, hidden: z.boolean(),
})
/** Optimistic supplement, correction or reversible hide decision. */
export type ReviewEdit = z.infer<typeof reviewEditSchema>
/** Persisted human edit with monotonic revision. */
export const reviewCorrectionSchema = reviewEditSchema.omit({ expectedRevision: true }).extend({ revision: z.number().int().positive() })
/** Durable human-owned content, excluded from automatic replacement. */
export type ReviewCorrection = z.infer<typeof reviewCorrectionSchema>
/** Last complete publication and independently recorded failed attempt. */
export const reviewDocumentSchema = z.object({
  day: reviewDaySchema, fingerprint: z.string(), activities: z.array(reviewActivitySchema), updatedAt: z.string(),
  error: z.string().nullable(), attempted: z.string(), failures: z.number().int().nonnegative(),
})
/** Published analysis remains readable if its replacement fails. */
export type ReviewDocument = z.infer<typeof reviewDocumentSchema>
/** View of one calendar week with independently readable daily results. */
export interface ReviewWeek {
  from: string
  today: string
  timeZone: string
  days: { day: string; activities: ReviewActivity[]; updatedAt: string | null; error: string | null; stale: boolean }[]
  weekly: ReviewDocument | null
  weeklyStale: boolean
  corrections: ReviewCorrection[]
  running: boolean
  sourceErrors: string[]
  tasks: { id: JournalId; title: string }[]
  sources: Pick<ReviewSource, 'id' | 'day' | 'at' | 'kind' | 'label' | 'role'>[]
}
/** Deployment cadence and bounded model inputs, with explicit defaults for installed profiles. */
export const ReviewPolicySchema = Schema.object({
  enabled: Schema.boolean().default(true),
  timeZone: Schema.string().default('Asia/Shanghai'),
  intervalMinutes: Schema.number().min(5).max(1440).default(60),
  lookbackDays: Schema.number().step(1).min(7).max(90).default(7),
  maxInputChars: Schema.number().step(1).min(8000).default(60000),
  chunkChars: Schema.number().step(1).min(1000).default(12000),
  maxAttempts: Schema.number().step(1).min(1).default(3),
})
/** Resolved review deployment policy. */
export type ReviewPolicy = ReturnType<typeof ReviewPolicySchema>
