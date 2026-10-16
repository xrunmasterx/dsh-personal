/** JSON records crossing the workbench's wire and durable storage interfaces. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { personalProfileContentSchema, personalProfileEvidenceSnapshotSchema } from './profile/schema.ts'
import { tapdTodoSnapshotSchema } from './tapd/schema.ts'

/** Durable investigation identity, independent of the process-local Job identity. */
export type RunId = Branded<'PersonalWorkbenchRunId'>
/** A bounded, user-reviewed investigation plan. */
export type PlanId = Branded<'PersonalWorkbenchPlanId'>
/** Immutable evidence-snapshot identity. */
export type EvidenceSnapshotId = Branded<'PersonalWorkbenchEvidenceSnapshotId'>
/** A profile generation or immutable publication identity. */
export type ProfileId = Branded<'PersonalWorkbenchProfileId'>

/** Validate a durable investigation identifier. */
export const runIdSchema = z.uuid().transform(value => brandString<RunId>(value))
/** Validate a preview token before looking it up. */
export const planIdSchema = z.uuid().transform(value => brandString<PlanId>(value))
/** Validate a profile generation identifier. */
export const profileIdSchema = z.uuid().transform(value => brandString<ProfileId>(value))

/** Exact Report reference; the lookup hash and attachment crash ID remain separate. */
export const reportRefSchema = z.object({
  appId: z.string().min(1),
  platformId: z.number().int().positive(),
  issueId: z.string().nullable(),
  crashHash: z.string().min(1),
  crashId: z.string().nullable(),
  version: z.string().nullable(),
  uploadedAt: z.string().nullable(),
})
/** Exact Report selected in a board, plan, or history record. */
export type ReportRef = z.infer<typeof reportRefSchema>

/** The selected source, before an Issue is resolved into concrete Reports. */
export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tapd'), url: z.url() }),
  z.object({
    kind: z.literal('crash-issue'),
    appId: z.string().min(1),
    platformId: z.number().int().positive(),
    issueId: z.string().min(1),
  }),
  z.object({ kind: z.literal('crash-report'), report: reportRefSchema }),
])
/** Supported investigation origins. */
export type InvestigationTarget = z.infer<typeof targetSchema>
/** The original two analysis strategies. */
export type InvestigationMode = 'single' | 'dual'

/** Request validated before preparing a read-only preview. */
export const planRequestSchema = z.object({
  target: targetSchema,
  mode: z.enum(['single', 'dual']),
  samples: z.array(reportRefSchema),
  additionalContext: z.string().max(20_000),
})
/** User-selected source, analysis strategy, and optional sample subset. */
export type PlanRequest = z.infer<typeof planRequestSchema>

/** User-visible evidence scope, fixed before a model can start. */
export interface InvestigationPlan {
  id: PlanId
  title: string
  target: InvestigationTarget
  mode: InvestigationMode
  samples: ReportRef[]
  sourceRoot: string
  additionalContext: string
  createdAt: string
  expiresAt: string
  notes: string[]
}

/** Operational state is separate from external issue status and analysis stage. */
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'stopping',
  'completed',
  'no_evidence',
  'failed',
  'canceled',
  'interrupted',
])
/** Persistent execution states. */
export type RunStatus = z.infer<typeof runStatusSchema>
/** Stages emitted by the deterministic executor. */
export const phaseSchema = z.enum([
  'queued',
  'collecting',
  'preparing',
  'investigating',
  'mechanism',
  'attribution',
  'validating',
  'reporting',
  'finished',
])
/** The business step currently owning execution. */
export type InvestigationPhase = z.infer<typeof phaseSchema>

/** Files are resolved through an owned run record, never a caller's disk path. */
export const artifactSchema = z.object({
  id: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
})
/** One immutable report or structured-result artifact. */
export type Artifact = z.infer<typeof artifactSchema>

/** Observed source versions; a composite project root need not itself be a Git repository. */
export const sourceSnapshotSchema = z.object({
  capturedAt: z.string(),
  harnessVersion: z.string(),
  repositories: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      head: z.string().nullable(),
      ref: z.string().nullable(),
      refSha: z.string().nullable(),
      trackedChanges: z.number().int().nonnegative(),
      dirtyDigest: z.string().nullable(),
      fetchedAt: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
})
/** Source version observations retained at the beginning and end of execution. */
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>

/** Authoritative run record; large evidence and model inputs live in artifacts. */
export const runRecordSchema = z.object({
  id: runIdSchema,
  planId: planIdSchema,
  confirmedPlanIds: z.array(planIdSchema),
  sourceKey: z.string(),
  sourceKeys: z.array(z.string()),
  target: targetSchema,
  title: z.string(),
  mode: z.enum(['single', 'dual']),
  samples: z.array(reportRefSchema),
  caseKeys: z.array(z.string()),
  additionalContext: z.string(),
  sourceRoot: z.string(),
  configurationDigest: z.string(),
  status: runStatusSchema,
  phase: phaseSchema,
  completedCases: z.number().int().nonnegative(),
  totalCases: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  artifacts: z.array(artifactSchema),
  legacyRunId: z.string().nullable(),
  legacyLimitation: z.string().nullable(),
  timeline: z.array(z.object({ phase: phaseSchema, completedCases: z.number().int(), at: z.string() })).optional(),
  activity: z
    .object({ message: z.enum(['reading_source', 'model_running', 'validating_result']), at: z.string() })
    .optional(),
  provenance: z
    .object({ start: sourceSnapshotSchema, end: sourceSnapshotSchema.nullable(), changed: z.boolean() })
    .optional(),
})
/** Durable run returned by both boards and the investigation history. */
export type RunRecord = z.infer<typeof runRecordSchema>

/** Fixed absolute query window, preserved across every page and Report selection. */
export const crashQuerySchema = z
  .object({
    appId: z.string().min(1),
    platformId: z.number().int().positive(),
    from: z.number().int(),
    to: z.number().int(),
    version: z.string(),
    keyword: z.string(),
    issueId: z.string(),
    status: z.number().int().nullable(),
    offset: z.number().int().nonnegative(),
    rollingDays: z.number().positive().max(90).optional(),
  })
  .refine(
    value => value.to > value.from && value.to - value.from <= 7_776_000_000,
    'CrashSight query window must be positive and at most 90 days',
  )
/** Issue and Report queries always carry the user's complete filter. */
export type CrashQuery = z.infer<typeof crashQuerySchema>

/** Normalized row; absent provider statistics remain null. */
export interface CrashIssue {
  key: string
  appId: string
  platformId: number
  issueId: string
  title: string
  message: string
  stack: string
  status: number | null
  reports: number | null
  devices: number | null
  latestAt: string | null
  versions: string[]
  assignees: string[]
  latestMatchedReport: ReportRef | null
}

/** One fetched page, with the provider's total and exact query. */
export interface CrashPage {
  query: CrashQuery
  items: CrashIssue[]
  total: number
  nextOffset: number | null
  fetchedAt: string
}
/** Reports belonging to one Issue and the same board filter. */
export interface ReportPage {
  query: CrashQuery
  issueId: string
  items: ReportRef[]
  total: number
  nextOffset: number | null
}

/** A retained TAPD cache is distinguishable from a successful empty refresh. */
export const tapdCacheSchema = z.object({
  snapshot: tapdTodoSnapshotSchema.nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
})
/** Cached personal work items and the last refresh outcome. */
export type TapdCache = z.infer<typeof tapdCacheSchema>

/** Profile generation records preserve review revisions independently of publication. */
export const profileRecordSchema = z.object({
  id: profileIdSchema,
  snapshotId: z.string(),
  status: z.enum(['running', 'stopping', 'completed', 'failed', 'canceled', 'interrupted']),
  revision: z.number().int().nonnegative(),
  content: personalProfileContentSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
  activity: z
    .object({ message: z.enum(['reading_source', 'model_running', 'validating_result']), at: z.string() })
    .optional(),
})
/** Mutable draft until it is used to create an immutable publication. */
export type ProfileRecord = z.infer<typeof profileRecordSchema>
/** Publishing creates a separate immutable record and atomically selects its ID. */
export const publicationSchema = z.object({
  id: profileIdSchema,
  generationId: profileIdSchema,
  version: z.number().int().positive(),
  content: personalProfileContentSchema,
  publishedAt: z.string(),
})
/** An immutable, user-reviewed profile version. */
export type ProfilePublication = z.infer<typeof publicationSchema>
/** Evidence revision used by one generation. */
export const evidenceSnapshotSchema = personalProfileEvidenceSnapshotSchema

/** Review requests must match the currently displayed draft revision. */
export interface ReviewRequest {
  generationId: ProfileId
  claimId: string
  expectedRevision: number
  action: 'confirm' | 'reject'
  correction: string
}
/** Publishing is bound to the reviewed draft, not a newer concurrent edit. */
export interface PublishRequest {
  generationId: ProfileId
  expectedRevision: number
}

/** Public configuration omits credential values and private transport headers. */
export interface WorkbenchInfo {
  connectionId: string
  projectName: string
  sourceRoot: string
  tapdConfigured: boolean
  crashSightConfigured: boolean
  tapdWorkspaceIds: string[]
  apps: { appId: string; platformId: number; name: string }[]
  investigationModel: string
  profileModel: string
  pageSize: number
  maxCases: number
  queryWindowDays: number
  pollIntervalMs: number
  cacheTtlMs: number
  idlePollIntervalMs: number
}

/** Trend counts preserve unavailable statistics and the provider's local date. */
export interface CrashTrendPoint {
  date: string
  reports: number | null
  devices: number | null
}
/** Current Issue details, trend scope, and confirmed local TAPD associations. */
export interface CrashDetails {
  issue: CrashIssue | null
  query: CrashQuery
  issueId: string
  trend: CrashTrendPoint[]
  trendError: string | null
  trendTimeZone: string
  trendIgnoresKeyword: boolean
  tapdLinks: { url: string; title: string; runId: RunId }[]
  fetchedAt: string
}

/** Server-side filters for locally confirmed TAPD-to-CrashSight associations. */
export interface LinkedCrashQuery {
  offset: number
  text: string
}

/** One CrashSight Issue whose association was confirmed while reading a TAPD defect. */
export interface LinkedCrashItem {
  key: string
  tapd: {
    url: string
    id: string
    title: string
    status: string | null
    priority: string | null
    owner: string | null
    current: boolean
  }
  crash: {
    appId: string
    platformId: number
    issueId: string
    reportCount: number
    versions: string[]
  }
  runCount: number
  latestRun: {
    id: RunId
    status: RunStatus
    mode: InvestigationMode
    createdAt: string
  }
}

/** Bounded projection of CrashSight Issues reached through TAPD evidence only. */
export interface LinkedCrashPage {
  query: LinkedCrashQuery
  items: LinkedCrashItem[]
  total: number
  nextOffset: number | null
  summary: {
    tapdItems: number
    issues: number
    reports: number
  }
}
/** A byte-bounded window from a file whose whole content hash was verified. */
export interface EvidencePreview {
  id: string
  name: string
  totalBytes: number
  offset: number
  nextOffset: number | null
  content: string
}

/** Latest materials, drafts, and publications for the profile review page. */
export interface ProfileState {
  evidence: z.infer<typeof personalProfileEvidenceSnapshotSchema> | null
  drafts: ProfileRecord[]
  published: ProfilePublication | null
  versions: ProfilePublication[]
  evidenceCheckedAt?: string | undefined
}

/** Compact history row; full samples, files and context are loaded on selection. */
export type RunSummary = Pick<
  RunRecord,
  | 'id'
  | 'title'
  | 'mode'
  | 'status'
  | 'phase'
  | 'completedCases'
  | 'totalCases'
  | 'createdAt'
  | 'updatedAt'
  | 'legacyLimitation'
>
/** Server-side history filters and an explicit page offset. */
export interface RunQuery {
  offset: number
  target: InvestigationTarget | null
  text: string
  mode: 'all' | InvestigationMode
  status: 'all' | RunStatus
}
/** Bounded investigation history. */
export interface RunPage {
  query: RunQuery
  items: RunSummary[]
  total: number
  nextOffset: number | null
}
/** Version headers are loaded separately from immutable publication contents. */
export type PublicationSummary = Omit<ProfilePublication, 'content'>
/** Bounded profile histories; only the selected draft includes its content. */
export interface ProfileView {
  selectedDraftId: ProfileId | null
  selectedDraftPublication: { id: ProfileId; version: number } | null
  evidence: ProfileState['evidence']
  evidenceCheckedAt: string | null
  published: ProfilePublication | null
  drafts: ProfileRecord[]
  versions: PublicationSummary[]
  draftTotal: number
  versionTotal: number
  draftOffset: number
  versionOffset: number
  nextDraftOffset: number | null
  nextVersionOffset: number | null
}
/** Cheap polling response, independent of retained report and publication sizes. */
export interface WorkbenchChanges {
  revisions: Record<string, string>
  activeRuns: { id: RunId; activity: NonNullable<RunRecord['activity']> | null }[]
  activeProfiles: { id: ProfileId; activity: NonNullable<ProfileRecord['activity']> | null }[]
}
