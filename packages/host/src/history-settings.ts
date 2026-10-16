/** Native persisted archive preferences and deployment-owned source/read bounds. */
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HistoryReadPolicy } from './history-readers.ts'

/** Deployment limits and local source paths; UI preferences remain independent. */
export interface HistoryPolicy extends HistoryReadPolicy {
  /** Local Codex home containing the indexed rollout files. */
  codexHome: string
  /** Local Cursor IDE globalStorage directory. */
  cursorStorage: string
  /** Maximum characters in a complete serialized analysis request. */
  maxInputChars: number
  /** Additional attempts with validation feedback after malformed model output. */
  repairAttempts: number
  /** Maximum characters of malformed output included in repair feedback. */
  maxRepairChars: number
  /** Maximum serialized bytes per retained record; zero disables the quota without truncating text. */
  maxRecordBytes: number
  /** Consecutive failure limit before explicit retry is required. */
  maxAttempts: number
  /** Initial retry delay, doubled after each consecutive failure. */
  retryDelayMs: number
}
/** Validated deployment policy; paths refer only to the Host's local machine. */
export const HistoryPolicySchema: Schema<HistoryPolicy> = Schema.object({
  codexHome: Schema.string().default(join(homedir(), '.codex')),
  cursorStorage: Schema.string().default(join(process.env.APPDATA ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config'), 'Cursor', 'User', 'globalStorage')),
  stableMs: Schema.number().min(0).default(30_000),
  maxMessageChars: Schema.number().step(1).min(100).default(12_000),
  maxSessionBytes: Schema.number().step(1).min(1024).default(32_000_000),
  maxInputChars: Schema.number().step(1).min(1000).default(60_000),
  repairAttempts: Schema.number().step(1).min(0).max(3).default(1),
  maxRepairChars: Schema.number().step(1).min(100).default(6000),
  maxRecordBytes: Schema.number().step(1).min(0).default(0),
  maxAttempts: Schema.number().step(1).min(1).default(3),
  retryDelayMs: Schema.number().min(1000).default(300_000),
})

/** Native settings section schema, sampled atomically at the start of each run. */
export const HistoryPreferenceSchema = Schema.object({
  enabled: Schema.boolean().required(), codex: Schema.boolean().required(), cursor: Schema.boolean().required(),
  intervalMinutes: Schema.number().step(1).min(5).max(1440).required(),
  lookback: Schema.union(['week', '7', '14', 'month']).required(),
  model: Schema.object({ provider: Schema.string().required(), model: Schema.string().required() }).required(),
})
