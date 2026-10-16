import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { collectPersonalProfileEvidence } from '../src/profile/evidence.ts'
import { evidenceDigest, factKey, factVersion } from '../src/profile/facts.ts'
import { projectLegacyInvestigation } from '../src/profile/legacy.ts'
import { buildPersonalProfileContent } from '../src/profile/rules.ts'
import type { PersonalProfileContent, PersonalProfileEvidence } from '../src/profile/schema.ts'
import { aiDraft, evidenceSnapshot, runRecord } from './helpers.ts'

const now = new Date('2026-09-03T12:00:00.000Z')
const empty = { claims: [], currentFocus: [] }
const fact = (id: string): PersonalProfileEvidence => ({ ...evidenceSnapshot().evidence[0]!, id, entityId: id })
const content = (
  evidence: PersonalProfileEvidence[],
  previousPublished: PersonalProfileContent | null = null,
  draft = empty,
) =>
  buildPersonalProfileContent(
    { evidenceSnapshot: { ...evidenceSnapshot(), evidence }, previousPublished, rejectedClaims: [] },
    draft,
    now,
  )

describe('profile evidence migration regressions', () => {
  it('reuses intraday checks but advances the profile time window when the date changes', () => {
    const first = evidenceSnapshot()
    const later = { ...first, window: { ...first.window, end: '2026-09-03T12:00:00Z' } }
    expect(evidenceDigest(first)).toBe(evidenceDigest(later))
    const nextDay = { ...later, window: { ...later.window, end: '2026-09-04T12:00:00Z' } }
    expect(evidenceDigest(nextDay)).not.toBe(evidenceDigest(first))
  })
  it('counts independent facts before grading strength and confidence', () => {
    const git = fact('git:one')
    const tapd: PersonalProfileEvidence = { ...fact('tapd:two'), source: 'tapd', kind: 'work_item' }
    const result = buildPersonalProfileContent(
      {
        evidenceSnapshot: { ...evidenceSnapshot(), evidence: [git, tapd] },
        previousPublished: null,
        rejectedClaims: [],
      },
      { claims: [{ ...aiDraft.claims[0]!, evidenceRefs: [git.id, git.id, tapd.id] }], currentFocus: [] },
      now,
    )
    expect(result.claims[0]?.assessment).toBe('established')
    expect(result.claims[0]?.evidenceRefs).toHaveLength(2)
  })

  it('does not accumulate unreferenced evidence across 500 + 500 + 1 generations', () => {
    const first = content(Array.from({ length: 500 }, (_, i) => fact(`a:${i}`)))
    const second = content(
      Array.from({ length: 500 }, (_, i) => fact(`b:${i}`)),
      first,
    )
    const third = content([fact('new')], second)
    expect(first.evidence).toEqual([])
    expect(second.evidence).toEqual([])
    expect(third.evidence).toEqual([])
  })

  it('keeps one Case fact across reruns and keeps an unchanged rejected claim suppressed', async () => {
    const read = async (runId: string, conclusion = '同一结论') =>
      collectPersonalProfileEvidence(
        {
          readGitActivity: async () => {
            throw new Error('Git unavailable in this fixture')
          },
          readTapdSnapshot: async () => ({
            workspaceIds: [],
            items: [],
            counts: { stories: 0, bugs: 0, tasks: 0 },
            total: 0,
            fetchedAt: now.toISOString(),
            cacheExpiresAt: now.toISOString(),
          }),
          readInvestigations: async () => [
            {
              id: runId,
              title: '同一事故',
              occurredAt: now.toISOString(),
              tapdUrl: null,
              incidentKind: 'crash',
              cases: [
                {
                  id: 'app:10:hash',
                  crashSightUrl: 'https://crashsight.qq.com/unity/crashes/app/issue/report-id/hash?pid=10',
                  conclusion,
                  rootCauseOwner: 'unknown',
                  codePaths: [],
                  hypothesisTitles: [],
                },
              ],
            },
          ],
        },
        { id: randomUUID(), maxEvidence: 500, clock: () => now },
      )
    const first = await read(randomUUID())
    const second = await read(randomUUID())
    const original = first.evidence.find(item => item.kind === 'investigation')!
    const repeated = second.evidence.find(item => item.kind === 'investigation')!
    expect(repeated.id).toBe(original.id)
    expect(repeated.sourceRunId).not.toBe(original.sourceRunId)
    const draft = { claims: [{ ...aiDraft.claims[0]!, evidenceRefs: [original.id] }], currentFocus: [] }
    const publication = buildPersonalProfileContent(
      { evidenceSnapshot: first, previousPublished: null, rejectedClaims: [] },
      draft,
      now,
    )
    const next = buildPersonalProfileContent(
      { evidenceSnapshot: second, previousPublished: publication, rejectedClaims: [] },
      draft,
      now,
    )
    expect(next.evidence.filter(item => item.kind === 'investigation')).toHaveLength(1)
    const rejected = [
      {
        id: publication.claims[0]!.id,
        evidenceRefs: [original.id],
        facts: [{ key: factKey(original), version: factVersion(original) }],
      },
    ]
    const suppressed = buildPersonalProfileContent(
      { evidenceSnapshot: second, previousPublished: null, rejectedClaims: rejected },
      draft,
      now,
    )
    expect(suppressed.claims).toEqual([])
    const changed = await read(randomUUID(), '有新的源码证据，结论发生变化')
    const changedFact = changed.evidence.find(item => item.kind === 'investigation')!
    const reconsidered = buildPersonalProfileContent(
      { evidenceSnapshot: changed, previousPublished: null, rejectedClaims: rejected },
      { claims: [{ ...draft.claims[0]!, evidenceRefs: [changedFact.id] }], currentFocus: [] },
      now,
    )
    expect(reconsidered.claims).toHaveLength(1)
    expect(reconsidered.claims[0]?.reviewStatus).toBe('pending')
  })

  it('projects minimum legacy fields and preserves unknown conclusion levels without rewriting the original', () => {
    const run = { ...runRecord(), finishedAt: now.toISOString() }
    const raw = {
      incidentKind: 'crash',
      title: '旧版调查',
      cases: [
        {
          caseInput: {
            case: {
              id: 'case',
              crashSightUrl: 'https://crashsight.qq.com/unity/crashes/app/issue/report-id/hash?pid=10',
              platformId: 10,
            },
          },
          investigation: {
            oneSentenceConclusion: '保留旧结论',
            rootCauseOwner: 'unknown',
            codeLocations: [{ path: 'Renderer.cpp' }],
            hypotheses: [],
          },
        },
      ],
    }
    const before = JSON.stringify(raw)
    const projected = projectLegacyInvestigation(run, raw, 'personal')
    expect(projected?.cases[0]?.id).toBe('personal:crash:app:10:hash')
    expect(projected?.cases[0]?.conclusion).toContain('旧版未记录')
    expect(projected?.legacyProjection).toBe(true)
    expect(JSON.stringify(raw)).toBe(before)
    expect(projectLegacyInvestigation(run, { ...raw, cases: [] }, 'personal')).toBeNull()
  })
})
