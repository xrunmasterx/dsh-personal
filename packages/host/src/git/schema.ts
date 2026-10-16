/** Personal workbench git/schema; business rules migrated from ai-workflow. */

import { z } from 'zod'

/**
 * Integration lane used to group authored work into final commits.
 */
export const GIT_CAR_STABLE_REF = 'origin/cfh/dev/car_stable'

const gitShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/)
const gitActivityRangeSchema = z.enum(['week', '90d', 'all'])
const gitTargetMainStatusSchema = z.enum(['reachable', 'not_reachable', 'unknown'])
const gitProcessRelationSchema = z.enum(['cherry_pick_source', 'source_history', 'merged_history'])
const gitProcessDiscoverySchema = z.enum([
  'active_branch',
  'exact_cherry_pick',
  'merge_parents',
  'none',
  'source_unavailable',
])

const gitCommitFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
})

/**
 * Validate local Git facts before they enter a profile evidence snapshot.
 */
export const gitCommitFactSchema = z.object({
  repositoryId: z.uuid(),
  sha: gitShaSchema,
  parents: z.array(gitShaSchema),
  subject: z.string(),
  body: z.string(),
  authorName: z.string(),
  authorEmail: z.email(),
  authorDate: z.iso.datetime({ offset: true }),
  committerName: z.string(),
  committerEmail: z.string().min(1).max(320),
  committerDate: z.iso.datetime({ offset: true }),
  files: z.array(gitCommitFileSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  discoveredViaRef: z.string().min(1).nullable(),
  directRefs: z.array(z.string().min(1)),
  targetMainStatus: gitTargetMainStatusSchema,
  collectedAt: z.iso.datetime(),
})

/**
 * Validate an authored commit together with its integration relationship.
 */
export const gitProcessCommitFactSchema = gitCommitFactSchema.extend({
  relation: gitProcessRelationSchema,
})

const gitMainIntegrationSchema = z.object({
  sha: gitShaSchema,
  committerDate: z.iso.datetime({ offset: true }),
})

/**
 * Validate a final integration commit and the process commits that explain its work.
 */
export const gitFinalCommitFactSchema = gitCommitFactSchema.extend({
  targetMainStatus: z.union([z.literal('reachable'), z.literal('not_reachable')]),
  sourceCommitRef: z
    .string()
    .regex(/^[a-f0-9]{7,64}$/)
    .nullable(),
  processDiscovery: gitProcessDiscoverySchema,
  processCommits: z.array(gitProcessCommitFactSchema),
  mainIntegration: gitMainIntegrationSchema.nullable(),
})

const gitSemanticCommitSourceSchema = z.enum(['process_history', 'integration_fallback'])

const gitActivityCommitSchema = gitFinalCommitFactSchema.extend({
  semanticCommit: gitCommitFactSchema,
  semanticCommitSource: gitSemanticCommitSourceSchema,
  semanticCommitUrl: z.url().optional(),
  carStableCommitUrl: z.url().optional(),
  mainIntegrationCommitUrl: z.url().optional(),
})

const gitActivitySummarySchema = z.object({
  commitCount: z.number().int().nonnegative(),
  repositoryCount: z.number().int().nonnegative(),
  filesChanged: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  byDay: z.array(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      commits: z.number().int().nonnegative(),
    }),
  ),
})

/**
 * Validate one bounded collection of semantic commits and aggregate counts.
 */
export const gitActivitySchema = z.object({
  range: gitActivityRangeSchema,
  windowStart: z.iso.datetime().nullable(),
  windowEnd: z.iso.datetime(),
  commits: z.array(gitActivityCommitSchema),
  observations: z
    .array(
      z.object({
        repositoryId: z.uuid(),
        targetMainRef: z.string(),
        targetMainSha: gitShaSchema,
        fetchedAt: z.iso.datetime().nullable(),
      }),
    )
    .optional(),
  summary: gitActivitySummarySchema,
})
/**
 * How an authored commit contributes to an integration commit.
 */
export type GitProcessRelation = z.infer<typeof gitProcessRelationSchema>
/**
 * Validated local commit facts, including author identity and changed-file counts.
 */
export type GitCommitFact = z.infer<typeof gitCommitFactSchema>
/**
 * An authored commit with its relationship to the final integration.
 */
export type GitProcessCommitFact = z.infer<typeof gitProcessCommitFactSchema>
/**
 * An integration commit retaining the authored history and mainline reachability.
 */
export type GitFinalCommitFact = z.infer<typeof gitFinalCommitFactSchema>
/**
 * Whether authored process history or an integration fallback supplies the evidence.
 */
export type GitSemanticCommitSource = z.infer<typeof gitSemanticCommitSourceSchema>
/**
 * One final commit paired with the selected authored work and source links.
 */
export type GitActivityCommit = z.infer<typeof gitActivityCommitSchema>
/**
 * A dated collection of semantic commit evidence; counts do not score ability.
 */
export type GitActivity = z.infer<typeof gitActivitySchema>
