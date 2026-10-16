import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { profileIdSchema } from '../src/models.ts'
import { queryChanges, queryLinkedCrashes, queryProfile, queryRuns } from '../src/queries.ts'
import { buildPersonalProfileContent } from '../src/profile/rules.ts'
import { aiDraft, evidenceSnapshot, harness, runRecord } from './helpers.ts'

describe('bounded workbench projections', () => {
  it('filters before paging without sending samples, context or large artifacts', async () => {
    const h = await harness()
    try {
      const target = runRecord().target
      for (let index = 0; index < 7; index++) {
        const run = {
          ...runRecord(),
          status: 'completed' as const,
          additionalContext: 'large context'.repeat(1000),
          title: `Run ${index}`,
        }
        await h.store.domain.table('runs').put(run.id, run)
      }
      const query = { offset: 2, target, text: 'Run', mode: 'all' as const, status: 'completed' as const }
      const page = queryRuns(h.store, query, 'test', 2)
      expect(page.total).toBe(7)
      expect(page.items).toHaveLength(2)
      expect(page.nextOffset).toBe(4)
      expect(JSON.stringify(page)).not.toContain('large context')
      expect(JSON.stringify(page)).not.toContain('samples')
      expect(JSON.stringify(queryChanges(h.store)).length).toBeLessThan(1500)
    } finally {
      await h.close()
    }
  })

  it('loads one draft body and recognizes publications outside the visible version page', async () => {
    const h = await harness()
    try {
      const evidence = evidenceSnapshot()
      const content = buildPersonalProfileContent(
        { evidenceSnapshot: evidence, previousPublished: null, rejectedClaims: [] },
        aiDraft,
        new Date(evidence.createdAt),
      )
      const ids = []
      for (let index = 0; index < 5; index++) {
        const id = profileIdSchema.parse(randomUUID())
        ids.push(id)
        await h.store.domain
          .table('profiles')
          .put(id, {
            id,
            snapshotId: evidence.id,
            content,
            revision: 1,
            status: 'completed',
            createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
            updatedAt: evidence.createdAt,
            error: null,
          })
        const publicationId = profileIdSchema.parse(randomUUID())
        await h.store.domain
          .table('publications')
          .put(publicationId, {
            id: publicationId,
            generationId: id,
            version: index + 1,
            content,
            publishedAt: evidence.createdAt,
          })
      }
      const page = queryProfile(h.store, ids[0]!, 3, 0, 2)
      expect(page.drafts.filter(draft => draft.content !== null)).toHaveLength(1)
      expect(page.selectedDraftId).toBe(ids[0])
      expect(page.selectedDraftPublication?.version).toBe(1)
      expect(page.versions.map(version => version.version)).toEqual([5, 4])
      expect(page.versions.every(version => !('content' in version))).toBe(true)
      expect(page.draftTotal).toBe(5)
      expect(queryProfile(h.store, ids[0]!, 0, 0, 2).selectedDraftId).toBe(ids[4])
    } finally {
      await h.close()
    }
  })

  it('groups only TAPD-confirmed CrashSight associations and keeps the newest run', async () => {
    const h = await harness()
    try {
      await h.store.domain.table('tapd').put('current', {
        snapshot: {
          workspaceIds: ['12345678'],
          items: [{
            key: 'tapd:12345678:bug:101234567890',
            kind: 'bug',
            id: '101234567890',
            workspaceId: '12345678',
            title: '当前 TAPD 标题',
            status: '处理中',
            priority: '高',
            owner: 'owner',
          }],
          counts: { stories: 0, bugs: 1, tasks: 0 },
          total: 1,
          fetchedAt: '2026-09-04T00:00:00.000Z',
          cacheExpiresAt: '2026-09-04T00:05:00.000Z',
        },
        lastError: null,
        lastAttemptAt: '2026-09-04T00:00:00.000Z',
      })
      const older = {
        ...runRecord(),
        target: { kind: 'tapd' as const, url: 'https://tapd.woa.com/tapd_fe/12345678/bug/detail/101234567890' },
        title: '旧标题',
        status: 'completed' as const,
        createdAt: '2026-09-01T00:00:00.000Z',
      }
      const newer = {
        ...runRecord(),
        target: {
          kind: 'tapd' as const,
          url: 'https://tapd.woa.com/tapd_fe/12345678/bug/detail/101234567890?from=investigation',
        },
        title: '新标题',
        status: 'failed' as const,
        samples: [{ ...older.samples[0]!, crashHash: 'report-b', version: 'v2' }],
        createdAt: '2026-09-03T00:00:00.000Z',
      }
      const directCrash = { ...runRecord(), createdAt: '2026-09-04T00:00:00.000Z' }
      await h.store.domain.table('runs').put(older.id, older)
      await h.store.domain.table('runs').put(newer.id, newer)
      await h.store.domain.table('runs').put(directCrash.id, directCrash)

      const page = queryLinkedCrashes(h.store, { offset: 0, text: '' }, 10)
      expect(page.summary).toEqual({ tapdItems: 1, issues: 1, reports: 2 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({
        tapd: { title: '当前 TAPD 标题', status: '处理中', priority: '高', owner: 'owner', current: true },
        crash: { issueId: 'issue', reportCount: 2, versions: ['v1', 'v2'] },
        runCount: 2,
        latestRun: { id: newer.id, status: 'failed' },
      })
      expect(queryLinkedCrashes(h.store, { offset: 0, text: 'missing' }, 10).total).toBe(0)
    } finally {
      await h.close()
    }
  })
})
