/** Personal workbench incident/schema; business rules migrated from ai-workflow. */

import { z } from 'zod'

const incidentKindSchema = z.enum(['bug', 'crash', 'insufficient_evidence'])

const conclusionLevelSchema = z.enum(['范围定位', '原因候选', '高置信根因', '根因已验证', '修复已验证'])

const causalDepthSchema = z.enum(['reporting_site', 'failure_mechanism', 'root_cause_candidate', 'root_cause'])

/**
 * Validate a source fact with source references, Case ownership and availability.
 */
export const evidenceItemSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1).nullable(),
  source: z.enum(['tapd', 'crashsight']),
  kind: z.enum([
    'ticket',
    'comment',
    'image',
    'video',
    'log',
    'stack',
    'dump',
    'report',
    'metadata',
    'archive',
    'other',
  ]),
  status: z.enum(['analyzed', 'available_for_analysis', 'available_not_analyzed', 'unavailable']),
  locator: z.string().min(1),
  summary: z.string().min(1),
  observedFacts: z.array(z.string().min(1)),
})

const missingEvidenceSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1).nullable(),
  description: z.string().min(1),
  reason: z.string().min(1),
  requestedInput: z.string().min(1),
  blocking: z.boolean(),
})

const binaryArtifactSchema = z.object({
  caseId: z.string().min(1).nullable(),
  name: z.string().min(1),
  kind: z.enum(['video', 'minidump', 'aftermath', 'nsight', 'pix', 'archive', 'other']),
  status: z.enum(['available_not_analyzed', 'unavailable']),
  locator: z.string().min(1),
  reason: z.string().min(1),
  nextAction: z.string().min(1),
  requiredIfTextEvidenceInsufficient: z.boolean(),
})

const sourceVersionSchema = z.object({
  buildVersion: z.string().min(1).nullable(),
  platform: z.string().min(1).nullable(),
  projectStream: z.string().min(1).nullable(),
  projectChangelist: z.string().min(1).nullable(),
  engineBranch: z.string().min(1).nullable(),
  engineCommit: z.string().min(1).nullable(),
})

const runtimeEnvironmentSchema = z.object({
  commandLine: z.string().min(1).nullable(),
  rhi: z.string().min(1).nullable(),
  gpu: z.string().min(1).nullable(),
  deviceProfile: z.string().min(1).nullable(),
  perfGearQualityLevel: z.enum(['Low', 'Medium', 'High', 'Epic', 'Cinematic', 'unknown']),
  perfGearSource: z.string().min(1).nullable(),
})

const actionableFrameSchema = z.object({
  module: z.string().min(1),
  symbol: z.string().min(1),
  file: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
})

/**
 * Validate the concrete Report, environment and evidence identifiers of one incident.
 */
export const incidentCaseSchema = z.object({
  id: z.string().min(1),
  incidentKind: incidentKindSchema,
  crashSightUrl: z.url().nullable(),
  appId: z.string().min(1).nullable(),
  platformId: z.string().min(1).nullable(),
  issueId: z.string().min(1).nullable(),
  reportId: z.string().min(1).nullable(),
  exceptionName: z.string().min(1).nullable(),
  exceptionMessage: z.string().min(1).nullable(),
  exceptionAddress: z.string().min(1).nullable(),
  crashingProcess: z.string().min(1).nullable(),
  crashingThread: z.string().min(1).nullable(),
  actionableFrames: z.array(actionableFrameSchema),
  sourceVersion: sourceVersionSchema,
  environment: runtimeEnvironmentSchema,
  evidenceRefs: z.array(z.string().min(1)),
  missingEvidenceRefs: z.array(z.string().min(1)),
})

const attachmentCandidateSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1).nullable(),
  evidenceRef: z.string().min(1),
  attachmentId: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1).nullable(),
  kind: z.enum(['text_log', 'log_archive']),
})

const evidenceFileKindSchema = z.enum(['runtime_log', 'main_stack', 'thread_dump', 'metadata', 'other_text'])

const attachmentTextFileSchema = z.object({
  evidenceId: z.string().min(1),
  name: z.string().min(1),
  kind: evidenceFileKindSchema,
  source: z.enum(['tapd', 'crashsight']),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

/**
 * Validate attachment materialization status and verified extracted-file metadata.
 */
export const attachmentArtifactSchema = attachmentCandidateSchema.extend({
  status: z.enum(['extracted', 'downloaded', 'failed']),
  localPath: z.string().min(1).nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  textFiles: z.array(attachmentTextFileSchema),
  error: z.string().min(1).nullable(),
})

const mcpSourceCallsSchema = z.object({
  tapdTools: z.array(z.string().min(1)),
  crashSightTools: z.array(z.string().min(1)),
  failedToolCalls: z.array(
    z.object({
      server: z.string().min(1),
      tool: z.string().min(1),
      error: z.string().min(1),
    }),
  ),
})

const evidenceCollectionPayloadSchema = z.object({
  ticket: z
    .object({
      url: z.url(),
      workspaceId: z.string().min(1).nullable(),
      workItemId: z.string().min(1).nullable(),
      objectType: z.enum(['bug', 'story', 'task', 'unknown']),
      title: z.string().min(1),
      descriptionSummary: z.string(),
    })
    .nullable(),
  classification: z.object({
    kind: incidentKindSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1),
  }),
  symptoms: z.array(z.string().min(1)),
  reproductionSteps: z.array(z.string().min(1)),
  evidenceItems: z.array(evidenceItemSchema),
  cases: z.array(incidentCaseSchema),
  missingEvidence: z.array(missingEvidenceSchema),
  binaryArtifacts: z.array(binaryArtifactSchema),
  attachmentCandidates: z.array(attachmentCandidateSchema),
  collectionErrors: z.array(z.string().min(1)),
  collectionNotes: z.array(z.string().min(1)),
})

/**
 * Validate the complete collection result before independent Case analysis.
 */
export const evidenceDossierSchema = evidenceCollectionPayloadSchema.extend({
  scope: z.string().min(1),
  provenance: mcpSourceCallsSchema,
  humanContext: z.string().min(1).nullable(),
  evidenceRoot: z.string().min(1).nullable(),
  attachmentArtifacts: z.array(attachmentArtifactSchema),
})

const debugEvidenceItemSchema = evidenceItemSchema.omit({ caseId: true })

const debugEvidenceFileSchema = attachmentTextFileSchema.omit({ relativePath: true })

const debugBinaryArtifactSchema = binaryArtifactSchema.omit({ caseId: true })

/**
 * Validate the evidence subset admitted to one independent model request.
 */
export const debugCaseInputSchema = z.object({
  ticket: z
    .object({
      url: z.url(),
      title: z.string().min(1),
      descriptionSummary: z.string(),
    })
    .nullable(),
  case: incidentCaseSchema,
  symptoms: z.array(z.string().min(1)),
  reproductionSteps: z.array(z.string().min(1)),
  evidenceItems: z.array(debugEvidenceItemSchema),
  evidenceFiles: z.array(debugEvidenceFileSchema),
  binaryArtifacts: z.array(debugBinaryArtifactSchema).default([]),
  missingEvidence: z.array(missingEvidenceSchema.omit({ caseId: true, blocking: true })),
  humanContext: z.string().min(1).nullable(),
})

const codeLocationSchema = z.object({
  scope: z.enum(['project', 'engine']),
  path: z.string().min(1),
  symbol: z.string().min(1).nullable(),
  line: z.number().int().positive().nullable(),
  role: z.enum(['crash_site', 'trigger', 'root_cause_candidate', 'supporting']),
  rationale: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
})

const hypothesisSchema = z.object({
  id: z.string().min(1),
  rank: z.number().int().positive(),
  title: z.string().min(1),
  evidenceLevel: z.enum(['observed', 'correlated', 'hypothesis']),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  supportingEvidenceRefs: z.array(z.string().min(1)),
  contradictingEvidenceRefs: z.array(z.string().min(1)),
  fixRecommendation: z.string().min(1).nullable(),
  fixRisk: z.string().min(1).nullable(),
  verificationSteps: z.array(z.string().min(1)).max(3),
})

const causalChainStepSchema = z.object({
  statement: z.string().min(1),
  evidenceLevel: z.enum(['observed', 'correlated', 'hypothesis']),
  evidenceRefs: z.array(z.string().min(1)),
})

const evidenceFileReviewSchema = z.object({
  evidenceRef: z.string().min(1),
  coverage: z.enum(['partial', 'full']),
  reviewedRanges: z.array(z.string().min(1)).min(1),
  keyFindings: z.array(z.string().min(1)),
})

const rootCauseAnalysisSchema = z.object({
  whyNow: z.string().min(1),
  origin: z.enum([
    'project',
    'custom_engine',
    'upstream_ue',
    'content_configuration',
    'platform_driver',
    'third_party',
    'multi_factor',
    'unknown',
  ]),
  originRationale: z.string().min(1),
  changeCandidates: z
    .array(
      z.object({
        identifier: z.string().min(1).nullable(),
        evidenceLevel: z.enum(['observed', 'correlated', 'hypothesis']),
        explanation: z.string().min(1),
      }),
    )
    .max(4),
  historyReviewed: z.array(z.string().min(1)),
  escapeAnalysis: z.string().min(1),
  preventionLessons: z.array(z.string().min(1)).max(3),
})

/**
 * Validate attribution output, evidence citations and the supported conclusion level.
 */
export const investigationDraftSchema = z.object({
  caseId: z.string().min(1),
  incidentKind: incidentKindSchema,
  conclusionLevel: conclusionLevelSchema,
  causalDepth: causalDepthSchema,
  oneSentenceConclusion: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.number().min(0).max(1),
  crashSite: z.string().min(1).nullable(),
  trigger: z.string().min(1).nullable(),
  rootCauseOwner: z.enum(['project', 'engine', 'content_configuration', 'platform_driver', 'third_party', 'unknown']),
  codeLocations: z.array(codeLocationSchema),
  fileReviews: z.array(evidenceFileReviewSchema),
  causalChain: z.array(causalChainStepSchema).min(1),
  rootCauseAnalysis: rootCauseAnalysisSchema.nullable(),
  hypotheses: z.array(hypothesisSchema).max(4),
  nextActions: z.array(z.string().min(1)).max(3),
  limitations: z.array(z.string().min(1)),
})

/**
 * Validate the mechanism handoff that precedes independent attribution.
 */
export const mechanismInvestigationDraftSchema = z.object({
  caseId: z.string().min(1),
  incidentKind: incidentKindSchema,
  causalDepth: causalDepthSchema,
  oneSentenceConclusion: z.string().min(1),
  summary: z.string().min(1),
  crashSite: z.string().min(1).nullable(),
  trigger: z.string().min(1).nullable(),
  violatedContract: z.string().min(1).nullable(),
  codeLocations: z.array(codeLocationSchema),
  fileReviews: z.array(evidenceFileReviewSchema),
  causalChain: z.array(causalChainStepSchema).min(1),
  limitations: z.array(z.string().min(1)),
})

const investigationCaseBundleSchema = z.object({
  caseInput: debugCaseInputSchema,
  investigation: investigationDraftSchema,
})

/**
 * Validate one Case with its normalized investigation and validation warnings.
 */
export const validatedInvestigationCaseSchema = investigationCaseBundleSchema.extend({
  validationWarnings: z.array(z.string().min(1)),
  mechanism: mechanismInvestigationDraftSchema.optional(),
})

/**
 * Validate the committed report, source dossier and independently analyzed Cases.
 */
export const investigationReportContentSchema = z.object({
  status: z.enum(['completed', 'no_evidence']),
  incidentKind: incidentKindSchema,
  title: z.string().min(1),
  markdown: z.string().min(1),
  dossier: evidenceDossierSchema,
  cases: z.array(validatedInvestigationCaseSchema),
})
/**
 * A collected ticket and Report set retaining missing-evidence explanations.
 */
export type EvidenceDossier = z.infer<typeof evidenceDossierSchema>
/**
 * One concrete Report and its analysis environment.
 */
export type IncidentCase = z.infer<typeof incidentCaseSchema>
/**
 * An eligible remote attachment before materialization; it retains Case ownership.
 */
export type AttachmentCandidate = z.infer<typeof attachmentCandidateSchema>
/**
 * A downloaded or failed attachment with verified file metadata and limitations.
 */
export type AttachmentArtifact = z.infer<typeof attachmentArtifactSchema>
/**
 * A Case-specific evidence view that excludes neighboring Report contents.
 */
export type DebugCaseInput = z.infer<typeof debugCaseInputSchema>
/**
 * A model-produced causal assessment before normalization and citation checks.
 */
export type InvestigationDraft = z.infer<typeof investigationDraftSchema>
/**
 * A mechanism-only result passed to a fresh attribution context.
 */
export type MechanismInvestigationDraft = z.infer<typeof mechanismInvestigationDraftSchema>
/**
 * One isolated Case input paired with its model attribution.
 */
export type InvestigationCaseBundle = z.infer<typeof investigationCaseBundleSchema>
/**
 * Committed Chinese report content with its dossier and validated Cases.
 */
export type InvestigationReportContent = z.infer<typeof investigationReportContentSchema>
