/** Validated deployment settings for the opt-in personal workbench. */
import Schema from '@deepseek-ai/schemastery'
import { personalProfileIdentity, personalProfileIdentitySchema } from './profile/schema.ts'
import type { z } from 'zod'
import { ReviewPolicySchema, type ReviewPolicy } from './review-schema.ts'
import { CodePolicySchema } from './code-settings.ts'
import { HistoryPolicySchema, type HistoryPolicy } from './history-settings.ts'

/** An explicitly selected CrashSight application and platform. */
export interface CrashApp {
  /** CrashSight application identity. */
  appId: string
  /** Numeric CrashSight platform identity. */
  platformId: number
  /** Application label shown in the browser. */
  name: string
}

/** A local repository and the author identities included in profile evidence. */
export interface GitSource {
  /** Stable local repository identity. */
  id: string
  /** Absolute local repository path. */
  path: string
  /** Author email addresses admitted as work evidence. */
  authors: string[]
  /** Existing local ref used to establish mainline reachability. */
  targetMainRef: string
}

/** Workbench deployment settings; credentials are resolved only in the Host. */
export interface Config {
  /** Configured account identity used for personal profile evidence. */
  profileIdentity?: z.infer<typeof personalProfileIdentitySchema>
  /** Calendar review scheduling and model input bounds. */
  review?: ReviewPolicy
  /** Repository synchronization deployment limits. */
  code?: {
    /** Read-only Gongfeng MCP endpoint. */
    url: string
    /** Credential-service reference containing the bearer token. */
    tokenRef: string
    /** Maximum characters in one patch analysis chunk. */
    chunkChars: number
    /** Maximum serialized input characters; oversized requests fail without truncation. */
    maxInputChars: number
    /** Immediate JSON correction attempts after a completed malformed response. */
    repairAttempts: number
    /** Failed analysis attempts before explicit retry is required. */
    maxAttempts: number
  }
  /** Local conversation source paths and bounded analysis policy. */
  history?: HistoryPolicy
  /** Absolute directory for run artifacts, model snapshots and legacy archives. */
  dataRoot: string
  /** Stable account namespace used in Report and work-item identities. */
  connectionId: string
  /** Project label shown in the Personal browser. */
  projectName: string
  /** Absolute source tree used for read-only incident analysis. */
  sourceRoot: string
  /** TAPD workspaces admitted by incident previews; personal todo reads span the token owner's projects. */
  tapdWorkspaceIds: string[]
  /** CrashSight application and platform pairs admitted by every read. */
  crashApps: CrashApp[]
  /** Local repositories and author identities admitted as profile evidence. */
  gitSources: GitSource[]
  /** HTTPS TAPD MCP endpoint. */
  tapdUrl: string
  /** Credential reference containing the TAPD access token. */
  tapdTokenEnv: string
  /** HTTPS CrashSight MCP endpoint. */
  crashSightUrl: string
  /** Credential reference containing the CrashSight access token. */
  crashSightTokenEnv: string
  /** Codex provider identifier for auxiliary model calls. */
  modelProvider: string
  /** Codex model used by single and dual incident analysis. */
  investigationModel: string
  /** Codex model used for evidence-bound profile drafts. */
  profileModel: string
  /** Tool-free DSH task-description editing policy. */
  briefPolish: {
    /** Registered DSH provider route. */
    provider: string
    /** Model identifier on the selected provider. */
    model: string
    /** Reasoning effort accepted by the selected model. */
    reasoningEffort: string
    /** Deadline for each editing call, in milliseconds. */
    timeoutMs: number
    /** Maximum generated tokens per editing call. */
    maxOutputTokens: number
    /** Maximum serialized stream bytes accepted per editing call. */
    maxOutputBytes: number
  }
  /** Reasoning effort passed to each Codex thread. */
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh'
  /** Whether the read-only incident sandbox may use network access. */
  investigationNetworkAccess: boolean
  /** Maximum admitted foreground operation or background execution lifetime in milliseconds. */
  runTimeoutMs: number
  /** Maximum individual source request or Git command duration in milliseconds. */
  toolTimeoutMs: number
  /** Lifetime of an unconfirmed evidence preview in milliseconds. */
  planTtlMs: number
  /** Maximum concrete Reports admitted to one investigation. */
  maxCases: number
  /** Maximum admitted active investigations and profile generations. */
  maxConcurrentRuns: number
  /** Requested source page size; pagination follows the count actually returned. */
  pageSize: number
  /** Maximum bytes collected from a process or served as one registered artifact. */
  maxResultBytes: number
  /** Grace period before escalating worker-tree termination. */
  processGraceMs: number
  /** Freshness duration of a successful personal TAPD snapshot. */
  cacheTtlMs: number
  /** Initial CrashSight query interval in days. */
  queryWindowDays: number
  /** Browser polling interval for durable Host status. */
  pollIntervalMs: number
  /** Polling cadence for visible idle pages; active work uses pollIntervalMs. */
  idlePollIntervalMs: number
  /** Maximum UTF-8 bytes returned by one verified evidence preview. */
  maxPreviewBytes: number
  /** Timezone used by the CrashSight trend endpoint's date strings. */
  crashSightTimeZone: string
  /** Maximum source-balanced facts frozen before a profile model request. */
  maxProfileEvidence: number
  /** Workbench-owned storage admission and retention policies. */
  storage: {
    /** Maximum logical bytes across retained workbench files and records. */
    maxBytes: number
    /** Reserved file allowance for one admitted investigation or profile generation. */
    maxRunBytes: number
    /** Minimum free filesystem bytes required when admitting work or durable records. */
    minFreeBytes: number
    /** Age in hours before inactive temporary files and empty orphan directories are eligible. */
    temporaryRetentionHours: number
    /** Days to retain task images after their final task reference is removed. */
    imageRetentionDays: number
    /** Age in days before unreferenced material snapshots are eligible for automatic cleanup. */
    snapshotRetentionDays: number
    /** Age in days before unpublished, unreviewed terminal drafts are eligible for automatic cleanup. */
    draftRetentionDays: number
    /** Age in days before unreferenced terminal investigations enter explicit history cleanup. */
    runRetentionDays: number
    /** Minimum interval between automatic storage sweeps, in milliseconds. */
    sweepIntervalMs: number
  }
  /** Attachment limits applied while downloading and extracting, not after completion. */
  evidenceLimits: {
    /** Maximum number of attachment candidates processed for one investigation. */
    maxAttachments: number
    /** Maximum bytes streamed from one attachment download. */
    maxDownloadBytes: number
    /** Maximum cumulative bytes extracted from one archive. */
    maxExtractedBytes: number
    /** Maximum decompressed bytes for one archive entry. */
    maxExtractedFileBytes: number
    /** Maximum entry count accepted from one archive. */
    maxArchiveEntries: number
    /** Maximum bytes admitted from one collected text file. */
    maxCollectedTextFileBytes: number
    /** Maximum cumulative bytes of CrashSight text collected for one investigation. */
    maxCollectedTextTotalBytes: number
    /** Per-download deadline in milliseconds, including streamed response data. */
    downloadTimeoutMs: number
  }
}

/** Loader validation; profile composition supplies deployment defaults. */
export const Config: Schema<Config> = Schema.object({
  profileIdentity: Schema.object({ subjectId: Schema.string().required(), displayName: Schema.string().required(), role: Schema.string().required(), projects: Schema.array(String).required(), timezone: Schema.string().required(), visibility: Schema.const('private').required() }).default(personalProfileIdentity),
  dataRoot: Schema.string().required(),
  connectionId: Schema.string()
    .required()
    .pattern(/^[a-zA-Z0-9_-]+$/),
  projectName: Schema.string().required(),
  sourceRoot: Schema.string().required(),
  tapdWorkspaceIds: Schema.array(Schema.string().pattern(/^\d+$/)).required(),
  crashApps: Schema.array(
    Schema.object({
      appId: Schema.string().required(),
      platformId: Schema.number().step(1).min(1).required(),
      name: Schema.string().required(),
    }),
  ).required(),
  gitSources: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      path: Schema.string().required(),
      authors: Schema.array(String).required(),
      targetMainRef: Schema.string().required(),
    }),
  ).required(),
  tapdUrl: Schema.string().required(),
  tapdTokenEnv: Schema.string().required(),
  crashSightUrl: Schema.string().required(),
  crashSightTokenEnv: Schema.string().required(),
  modelProvider: Schema.string().required(),
  investigationModel: Schema.string().required(),
  profileModel: Schema.string().required(),
  history: HistoryPolicySchema,
  code: CodePolicySchema,
  review: ReviewPolicySchema,
  briefPolish: Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
    reasoningEffort: Schema.string().required(),
    timeoutMs: Schema.number().min(1).max(2_147_483_647).required(),
    maxOutputTokens: Schema.number().step(1).min(1).required(),
    maxOutputBytes: Schema.number().step(1).min(1).required(),
  }).required(),
  reasoningEffort: Schema.union(['low', 'medium', 'high', 'xhigh']).required(),
  investigationNetworkAccess: Schema.boolean().required(),
  runTimeoutMs: Schema.number().min(1).max(2_147_483_647).required(),
  toolTimeoutMs: Schema.number().min(1).max(2_147_483_647).required(),
  planTtlMs: Schema.number().min(1).max(2_147_483_647).required(),
  maxCases: Schema.number().step(1).min(1).required(),
  maxConcurrentRuns: Schema.number().step(1).min(1).required(),
  pageSize: Schema.number().step(1).min(1).max(100).required(),
  maxResultBytes: Schema.number().step(1).min(1).required(),
  processGraceMs: Schema.number().min(1).max(2_147_483_647).required(),
  cacheTtlMs: Schema.number().min(1).required(),
  queryWindowDays: Schema.number().min(1).max(90).required(),
  pollIntervalMs: Schema.number().min(100).required(),
  idlePollIntervalMs: Schema.number().min(1000).required(),
  maxPreviewBytes: Schema.number().step(1).min(1024).required(),
  crashSightTimeZone: Schema.string().required(),
  maxProfileEvidence: Schema.number().step(1).min(4).max(500).required(),
  storage: Schema.object({
    maxBytes: Schema.number().step(1).min(1).required(),
    maxRunBytes: Schema.number().step(1).min(1).required(),
    minFreeBytes: Schema.number().step(1).min(0).required(),
    temporaryRetentionHours: Schema.number().min(1).required(),
    imageRetentionDays: Schema.number().min(0).default(7),
    snapshotRetentionDays: Schema.number().min(1).required(),
    draftRetentionDays: Schema.number().min(1).required(),
    runRetentionDays: Schema.number().min(1).required(),
    sweepIntervalMs: Schema.number().min(1000).max(2_147_483_647).required(),
  }).required(),
  evidenceLimits: Schema.object({
    maxAttachments: Schema.number().step(1).min(1).required(),
    maxDownloadBytes: Schema.number().step(1).min(1).required(),
    maxExtractedBytes: Schema.number().step(1).min(1).required(),
    maxExtractedFileBytes: Schema.number().step(1).min(1).required(),
    maxArchiveEntries: Schema.number().step(1).min(1).required(),
    maxCollectedTextFileBytes: Schema.number().step(1).min(1).required(),
    maxCollectedTextTotalBytes: Schema.number().step(1).min(1).required(),
    downloadTimeoutMs: Schema.number().min(1).max(2_147_483_647).required(),
  }).required(),
})
