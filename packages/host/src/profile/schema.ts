/** Personal workbench profile/schema; business rules migrated from ai-workflow. */

import { z } from 'zod'

export const personalProfileIdentitySchema = z.object({
  subjectId: z.string().min(1),
  displayName: z.string().min(1),
  role: z.string().min(1),
  projects: z.array(z.string().min(1)),
  timezone: z.string().min(1),
  visibility: z.literal('private'),
})

/**
 * Fallback identity for unconfigured installations; saved identities remain readable.
 */
export const personalProfileIdentity = personalProfileIdentitySchema.parse({
  subjectId: 'personal',
  displayName: 'Personal',
  role: 'Software developer',
  projects: [],
  timezone: 'Asia/Shanghai',
  visibility: 'private',
})

const personalProfileSourceSchema = z.enum(['git', 'tapd', 'crashsight', 'knowledge', 'user'])

const personalProfileEvidenceKindSchema = z.enum([
  'commit',
  'work_item',
  'investigation',
  'document',
  'assertion',
])

const personalProfileEvidenceSchema = z.object({
  id: z.string().min(1).max(512),
  source: personalProfileSourceSchema,
  kind: personalProfileEvidenceKindSchema,
  entityId: z.string().min(1).max(512),
  occurredAt: z.iso.datetime({ offset: true }),
  collectedAt: z.iso.datetime({ offset: true }),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(4_000),
  tags: z.array(z.string().min(1).max(100)).max(30),
  url: z.url().nullable(),
  sourceRunId: z.uuid().optional(),
  legacyProjection: z.boolean().optional(),
})

const personalProfileSourceCoverageSchema = z.object({
  source: personalProfileSourceSchema,
  status: z.enum(['available', 'unavailable', 'not_connected']),
  itemCount: z.number().int().nonnegative(),
  cutoffAt: z.iso.datetime({ offset: true }),
  windowStart: z.iso.datetime({ offset: true }).nullable(),
  limitation: z.string().min(1).max(500).nullable(),
})

/**
 * Validate an immutable evidence collection and its time windows.
 */
export const personalProfileEvidenceSnapshotSchema = z.object({
  id: z.uuid(),
  identity: personalProfileIdentitySchema,
  window: z.object({
    recentStart: z.iso.datetime({ offset: true }),
    focusStart: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  }),
  coverage: z.array(personalProfileSourceCoverageSchema),
  evidence: z.array(personalProfileEvidenceSchema).max(500),
  createdAt: z.iso.datetime({ offset: true }),
})

const personalProfileDimensionSchema = z.enum([
  'domain',
  'technology',
  'capability',
  'delivery',
  'knowledge',
  'preference',
  'growth',
])

const personalProfileAssessmentSchema = z.enum([
  'core_strength',
  'established',
  'recent_practice',
  'exploring',
  'growth_area',
])

const personalProfileConfidenceSchema = z.enum(['high', 'medium', 'low'])
const personalProfileReviewStatusSchema = z.enum(['pending', 'confirmed', 'rejected'])

const personalProfileAiClaimSchema = z.object({
  dimension: personalProfileDimensionSchema,
  topic: z.string().trim().min(1).max(100),
  statement: z.string().trim().min(1).max(500),
  assessment: personalProfileAssessmentSchema,
  confidence: personalProfileConfidenceSchema,
  evidenceRefs: z.array(z.string().min(1)).min(1).max(20),
})

const personalProfileAiFocusSchema = z.object({
  topic: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(500),
  evidenceRefs: z.array(z.string().min(1)).min(1).max(20),
})

/**
 * Validate model-proposed claims and focus topics before human review.
 */
export const personalProfileAiDraftSchema = z.object({
  claims: z.array(personalProfileAiClaimSchema).max(30),
  currentFocus: z.array(personalProfileAiFocusSchema).max(10),
})

const personalProfileClaimSchema = personalProfileAiClaimSchema.extend({
  id: z.string().min(1).max(128),
  origin: z.enum(['inferred', 'user', 'mixed']),
  firstSeenAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  reviewStatus: personalProfileReviewStatusSchema,
})

const personalProfileFocusSchema = personalProfileAiFocusSchema.extend({
  id: z.string().min(1).max(128),
})

/**
 * Validate a profile with claim review decisions and resolvable evidence references.
 */
export const personalProfileContentSchema = z.object({
  identity: personalProfileIdentitySchema,
  summary: z.string().min(1).max(1_000),
  sourceSnapshotId: z.uuid(),
  sourceCoverage: z.array(personalProfileSourceCoverageSchema),
  evidence: z.array(personalProfileEvidenceSchema).max(1_200),
  claims: z.array(personalProfileClaimSchema).max(50),
  currentFocus: z.array(personalProfileFocusSchema).max(10),
  generatedAt: z.iso.datetime({ offset: true }),
})

const rejectedPersonalProfileClaimSchema = z.object({
  id: z.string().min(1),
  evidenceRefs: z.array(z.string().min(1)),
  facts: z.array(z.object({ key: z.string(), version: z.string() })).optional(),
})

/**
 * Validate the frozen evidence and previous human decisions for one generation.
 */
export const personalProfileWorkflowInputSchema = z.object({
  evidenceSnapshot: personalProfileEvidenceSnapshotSchema,
  previousPublished: personalProfileContentSchema.nullable(),
  rejectedClaims: z.array(rejectedPersonalProfileClaimSchema),
})
/**
 * One attributable work fact with a collection time and optional source link.
 */
export type PersonalProfileEvidence = z.infer<typeof personalProfileEvidenceSchema>
/**
 * Availability and limits of a source within the evidence window.
 */
export type PersonalProfileSourceCoverage = z.infer<typeof personalProfileSourceCoverageSchema>
/**
 * Immutable evidence and source coverage selected for profile generation.
 */
export type PersonalProfileEvidenceSnapshot = z.infer<typeof personalProfileEvidenceSnapshotSchema>
/**
 * The aspect of a technical profile described by a claim.
 */
export type PersonalProfileDimension = z.infer<typeof personalProfileDimensionSchema>
/**
 * Evidence-supported strength or growth classification, independent of delivery counts.
 */
export type PersonalProfileAssessment = z.infer<typeof personalProfileAssessmentSchema>
/**
 * Model proposals without authority to publish or override human review.
 */
export type PersonalProfileAiDraft = z.infer<typeof personalProfileAiDraftSchema>
/**
 * A profile statement retaining evidence references and a human review decision.
 */
export type PersonalProfileClaim = z.infer<typeof personalProfileClaimSchema>
/**
 * Profile claims and recent focus, retaining the evidence needed to review them.
 */
export type PersonalProfileContent = z.infer<typeof personalProfileContentSchema>
/**
 * One generation’s immutable evidence, previous publication and rejected claims.
 */
export type PersonalProfileWorkflowInput = z.infer<typeof personalProfileWorkflowInputSchema>
