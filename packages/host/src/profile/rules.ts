/** Personal workbench profile/rules; business rules migrated from ai-workflow. */

import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { factKey, factVersion } from './facts.ts'

import {
  personalProfileAiDraftSchema,
  personalProfileContentSchema,
  type PersonalProfileAiDraft,
  type PersonalProfileAssessment,
  type PersonalProfileClaim,
  type PersonalProfileContent,
  type PersonalProfileDimension,
  type PersonalProfileEvidence,
  type PersonalProfileWorkflowInput,
} from './schema.ts'

function normalizedTopic(topic: string): string {
  return topic.trim().toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ')
}

function createProfileClaimId(dimension: PersonalProfileDimension, topic: string): string {
  const digest = createHash('sha256')
    .update(`${dimension}\0${normalizedTopic(topic)}`, 'utf8')
    .digest('hex')
    .slice(0, 20)
  return `claim-${dimension}-${digest}`
}

function createFocusId(topic: string): string {
  return `focus-${createHash('sha256').update(normalizedTopic(topic), 'utf8').digest('hex').slice(0, 20)}`
}

function evidenceMap(input: PersonalProfileWorkflowInput): Map<string, PersonalProfileEvidence> {
  const allEvidence = [...(input.previousPublished?.evidence ?? []), ...input.evidenceSnapshot.evidence]
  const latest = new Map(allEvidence.map(item => [factKey(item), item]))
  return new Map(allEvidence.map((item) => {
    const fact = latest.get(factKey(item))
    assert(fact, 'Each evidence item establishes its fact group')
    return [item.id, fact]
  }))
}

function validateReferences(
  refs: string[],
  available: Map<string, PersonalProfileEvidence>,
  label: string,
): PersonalProfileEvidence[] {
  const facts = refs.map((ref) => {
    const evidence = available.get(ref)
    if (!evidence) throw new Error(`${label} 引用了冻结快照之外的证据：${ref}`)
    return evidence
  })
  return [...new Map(facts.map(item => [factKey(item), item])).values()]
}

function normalizeAssessment(
  requested: PersonalProfileAssessment,
  evidence: PersonalProfileEvidence[],
): PersonalProfileAssessment {
  const sourceCount = new Set(evidence.map(item => item.source)).size
  const evidenceCount = evidence.length
  if (requested === 'core_strength' && (evidenceCount < 3 || sourceCount < 2)) {
    return evidenceCount >= 2 ? 'established' : 'recent_practice'
  }
  if (requested === 'established' && evidenceCount < 2) return 'recent_practice'
  return requested
}

function normalizeConfidence(
  requested: 'high' | 'medium' | 'low',
  evidence: PersonalProfileEvidence[],
): 'high' | 'medium' | 'low' {
  if (requested === 'high' && evidence.length < 3 && new Set(evidence.map(item => item.source)).size < 2) {
    return 'medium'
  }
  return requested
}

function inferredOrigin(evidence: PersonalProfileEvidence[]): 'inferred' | 'user' | 'mixed' {
  const hasUser = evidence.some(item => item.source === 'user')
  if (!hasUser) return 'inferred'
  return evidence.every(item => item.source === 'user') ? 'user' : 'mixed'
}

function normalizeClaim(
  claim: PersonalProfileAiDraft['claims'][number],
  available: Map<string, PersonalProfileEvidence>,
): PersonalProfileClaim {
  const id = createProfileClaimId(claim.dimension, claim.topic)
  const evidence = validateReferences(claim.evidenceRefs, available, `画像主张 ${id}`)
  const times = evidence.map(item => Date.parse(item.occurredAt))
  return {
    id,
    dimension: claim.dimension,
    topic: claim.topic.trim(),
    statement: claim.statement.trim(),
    assessment: normalizeAssessment(claim.assessment, evidence),
    confidence: normalizeConfidence(claim.confidence, evidence),
    origin: inferredOrigin(evidence),
    evidenceRefs: evidence.map(item => item.id),
    firstSeenAt: new Date(Math.min(...times)).toISOString(),
    lastSeenAt: new Date(Math.max(...times)).toISOString(),
    reviewStatus: 'pending',
  }
}

function isSuppressed(
  claim: PersonalProfileClaim,
  rejectedClaims: PersonalProfileWorkflowInput['rejectedClaims'],
  available: Map<string, PersonalProfileEvidence>,
): boolean {
  return rejectedClaims
    .filter(item => item.id === claim.id)
    .some((rejected) => {
      const rejectedFacts = rejected.facts
      if (rejectedFacts) {
        return claim.evidenceRefs.every((ref) => {
          const fact = available.get(ref)
          assert(fact, 'Normalized claims reference admitted evidence')
          return rejectedFacts.some(item => item.key === factKey(fact) && item.version === factVersion(fact))
        })
      }
      const rejectedEvidence = new Set(rejected.evidenceRefs.map(ref => available.get(ref)?.id ?? ref))
      return claim.evidenceRefs.every(ref => rejectedEvidence.has(ref))
    })
}

function assessmentRank(assessment: PersonalProfileAssessment): number {
  switch (assessment) {
    case 'core_strength':
      return 0
    case 'established':
      return 1
    case 'recent_practice':
      return 2
    case 'exploring':
      return 3
    case 'growth_area':
      return 4
  }
}

function buildSummary(input: PersonalProfileWorkflowInput, claims: PersonalProfileClaim[]): string {
  const topics = claims
    .filter(claim => claim.assessment !== 'growth_area')
    .sort(
      (left, right) =>
        assessmentRank(left.assessment) - assessmentRank(right.assessment) ||
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
    )
    .map(claim => claim.topic)
    .filter((topic, index, values) => values.indexOf(topic) === index)
    .slice(0, 4)
  const base = `${input.evidenceSnapshot.identity.displayName} 的角色是${input.evidenceSnapshot.identity.role}。`
  return topics.length
    ? `${base} 当前画像证据主要覆盖 ${topics.join('、')}。`
    : `${base} 当前证据尚不足以形成稳定能力结论。`
}

/**
 * Validate evidence references and merge a draft with retained human decisions.
 * @param input - the frozen source records and operation settings.
 * @param rawDraft - untrusted model-proposed profile claims.
 * @param generatedAt - generation timestamp.
 * @returns the validated profile draft with human decisions preserved.
 */
export function buildPersonalProfileContent(
  input: PersonalProfileWorkflowInput,
  rawDraft: PersonalProfileAiDraft,
  generatedAt: Date,
): PersonalProfileContent {
  const parsedDraft = personalProfileAiDraftSchema.parse(rawDraft)
  const available = evidenceMap(input)
  const currentEvidenceIds = new Set(input.evidenceSnapshot.evidence.map(item => item.id))
  const normalizedClaims = new Map<string, PersonalProfileClaim>()

  for (const rawClaim of parsedDraft.claims) {
    const claim = normalizeClaim(rawClaim, available)
    if (!isSuppressed(claim, input.rejectedClaims, available) && !normalizedClaims.has(claim.id)) {
      normalizedClaims.set(claim.id, claim)
    }
  }

  for (const previous of input.previousPublished?.claims ?? []) {
    if (
      previous.reviewStatus === 'confirmed' &&
      (previous.assessment === 'core_strength' || previous.assessment === 'established') &&
      !normalizedClaims.has(previous.id) &&
      !input.rejectedClaims.some(rejected => rejected.id === previous.id)
    ) {
      const refs = validateReferences(previous.evidenceRefs, available, `上一版画像主张 ${previous.id}`).map(
        item => item.id,
      )
      normalizedClaims.set(previous.id, {
        ...previous,
        evidenceRefs: refs,
        reviewStatus: refs.every(ref => previous.evidenceRefs.includes(ref)) ? previous.reviewStatus : 'pending',
      })
    }
  }

  const currentFocus = parsedDraft.currentFocus.map((focus) => {
    const refs = validateReferences(focus.evidenceRefs, available, `当前关注 ${focus.topic}`).map(item => item.id)
    const staleRefs = focus.evidenceRefs.filter(ref => !currentEvidenceIds.has(ref))
    if (staleRefs.length) {
      throw new Error(`当前关注 ${focus.topic} 引用了非本次快照证据：${staleRefs.join(', ')}`)
    }
    return {
      id: createFocusId(focus.topic),
      topic: focus.topic.trim(),
      summary: focus.summary.trim(),
      evidenceRefs: refs,
    }
  })

  const allClaims = [...normalizedClaims.values()]
  const retainedIds = new Set(
    input.previousPublished?.claims.filter(claim => claim.reviewStatus === 'confirmed').map(claim => claim.id),
  )
  const claims = allClaims.sort((a, b) => Number(retainedIds.has(b.id)) - Number(retainedIds.has(a.id))).slice(0, 50)
  const used = new Set([...claims, ...currentFocus].flatMap(item => item.evidenceRefs))
  const evidence = [
    ...new Map([...available.values()].filter(item => used.has(item.id)).map(item => [item.id, item])).values(),
  ].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id))
  const sourceCoverage = [...input.evidenceSnapshot.coverage]
  if (allClaims.length > claims.length)
    sourceCoverage.push({
      source: 'user',
      status: 'available',
      itemCount: claims.length,
      cutoffAt: generatedAt.toISOString(),
      windowStart: null,
      limitation: `保留已确认主张优先；本版展示 ${claims.length} 条，另 ${allClaims.length - claims.length} 条新候选超出审核容量。`,
    })
  return personalProfileContentSchema.parse({
    identity: input.evidenceSnapshot.identity,
    summary: buildSummary(input, claims),
    sourceSnapshotId: input.evidenceSnapshot.id,
    sourceCoverage,
    evidence,
    claims,
    currentFocus,
    generatedAt: generatedAt.toISOString(),
  })
}
