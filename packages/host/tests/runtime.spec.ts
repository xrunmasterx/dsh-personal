import { describe, expect, it, vi } from 'vitest'
import { WorkbenchBoards } from '../src/boards.ts'
import { WorkbenchRuntime } from '../src/runtime.ts'
import { profileIdSchema, type PlanRequest } from '../src/models.ts'
import { buildPersonalProfileContent } from '../src/profile/rules.ts'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { aiDraft, evidenceSnapshot, harness, mcpSessions, runRecord, sample, tapdUrl } from './helpers.ts'

describe('durable workbench ownership', () => {
  it('reuses an active Report across both origins, preserves token idempotency after cancellation, and waits for cleanup', async () => {
    const h = await harness()
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    vi.spyOn(boards, 'sessions').mockImplementation(() => mcpSessions(calls))
    const entered = Promise.withResolvers<undefined>()
    const exited = Promise.withResolvers<undefined>()
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve()
          },
          { once: true },
        )
      })
      await exited.promise
      signal.throwIfAborted()
      return null
    })
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, { boards, execute })
    try {
      const crash = await runtime.createPlan({
        target: { kind: 'crash-report', report: sample },
        samples: [],
        mode: 'single',
        additionalContext: '',
      })
      const tapd = await runtime.createPlan({
        target: { kind: 'tapd', url: tapdUrl },
        samples: [],
        mode: 'single',
        additionalContext: '',
      })
      expect(execute).not.toHaveBeenCalled()
      const first = await runtime.startInvestigation(crash.id)
      await entered.promise
      const second = await runtime.startInvestigation(tapd.id)
      expect(second.id).toBe(first.id)
      expect(second.sourceKeys).toContain('test:tapd:12345678:bug:101234567890')
      expect(second.confirmedPlanIds).toEqual([crash.id, tapd.id])
      expect((await runtime.cancelInvestigation(first.id)).status).toBe('stopping')
      expect(runtime.getRun(first.id).status).toBe('stopping')
      exited.resolve(undefined)
      await vi.waitFor(() => {
        expect(runtime.getRun(first.id).status).toBe('canceled')
      })
      expect((await runtime.startInvestigation(tapd.id)).id).toBe(first.id)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(calls.filter(call => call.tool === 'fetch_last_crash_detail_in_issue')).toHaveLength(0)
      expect(calls.find(call => call.tool === 'get_report_attachments')?.args.crashId).toBe('native-report-a')
    } finally {
      exited.resolve(undefined)
      await runtime.close()
      await h.close()
    }
  })

  it('rejects conflicting active scopes and admits a different mode only as a new run', async () => {
    const h = await harness()
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    vi.spyOn(boards, 'sessions').mockImplementation(() => mcpSessions([]))
    const entered = Promise.withResolvers<undefined>()
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted()
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        }, { once: true })
      })
      signal.throwIfAborted()
      return null
    })
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, { boards, execute })
    try {
      const base: PlanRequest = {
        target: { kind: 'crash-report', report: sample },
        samples: [],
        mode: 'single',
        additionalContext: '',
      }
      const original = await runtime.createPlan(base)
      const first = await runtime.startInvestigation(original.id)
      await entered.promise
      const dual = await runtime.createPlan({ ...base, mode: 'dual' })
      const context = await runtime.createPlan({ ...base, additionalContext: '只检查新增的渲染路径' })
      const expanded = await runtime.createPlan({
        ...base,
        target: { kind: 'crash-issue', appId: 'app', platformId: 10, issueId: 'issue' },
        samples: [sample, { ...sample, crashHash: 'report-b', crashId: 'native-report-b' }],
      })
      for (const plan of [dual, context, expanded]) {
        await expect(runtime.startInvestigation(plan.id)).rejects.toThrow(/已有调查在执行/)
      }
      expect(runtime.getRun(first.id).confirmedPlanIds).toEqual([original.id])
      expect(runtime.listRuns()).toHaveLength(1)
      expect(execute).toHaveBeenCalledTimes(1)
      await runtime.cancelInvestigation(first.id)
      await vi.waitFor(() =>{  expect(runtime.getRun(first.id).status).toBe('canceled') })
      const second = await runtime.startInvestigation(dual.id)
      expect(second.id).not.toBe(first.id)
      expect(second.mode).toBe('dual')
      expect(runtime.getRun(first.id).mode).toBe('single')
    } finally {
      await runtime.close()
      await h.close()
    }
  })

  it('recovers nonterminal records without scheduling model work and verifies report bytes', async () => {
    const h = await harness()
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, {
      boards: new WorkbenchBoards(h.config, { resolve: async () => undefined }),
      execute: vi.fn(),
    })
    try {
      const run = runRecord()
      await h.store.domain.table('runs').put(run.id, run)
      await h.store.recover()
      expect(runtime.getRun(run.id).status).toBe('interrupted')
      await runtime.artifacts.json(run.id, 'result.json', { retained: true })
      const artifact = await runtime.artifacts.register(run.id, 'result', 'result.json')
      await h.store.domain.table('runs').put(run.id, { ...run, status: 'completed', artifacts: [artifact] })
      await expect(runtime.artifact(run.id, 'result')).resolves.toBeInstanceOf(Buffer)
      await writeFile(runtime.artifacts.directory(run.id) + '/result.json', '{"tampered":true}')
      await expect(runtime.artifact(run.id, 'result')).rejects.toThrow(/Artifact/)
    } finally {
      await runtime.close()
      await h.close()
    }
  })

  it('publishes only reviewed claims with revision checks and an immutable current pointer', async () => {
    const h = await harness()
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, {
      boards: new WorkbenchBoards(h.config, { resolve: async () => undefined }),
      execute: vi.fn(),
    })
    try {
      const evidence = evidenceSnapshot()
      const content = buildPersonalProfileContent(
        { evidenceSnapshot: evidence, previousPublished: null, rejectedClaims: [] },
        aiDraft,
        new Date(evidence.createdAt),
      )
      const id = profileIdSchema.parse(randomUUID())
      await h.store.domain.table('evidence').put(evidence.id, evidence)
      await h.store.domain
        .table('profiles')
        .put(id, {
          id,
          snapshotId: evidence.id,
          content,
          revision: 1,
          status: 'completed',
          createdAt: evidence.createdAt,
          updatedAt: evidence.createdAt,
          error: null,
        })
      await expect(runtime.publishProfile({ generationId: id, expectedRevision: 1 })).rejects.toThrow(/Review all/)
      const reviewed = await runtime.reviewClaim({
        generationId: id,
        expectedRevision: 1,
        claimId: content.claims[0]!.id,
        action: 'confirm',
        correction: '',
      })
      await expect(
        runtime.reviewClaim({
          generationId: id,
          expectedRevision: 1,
          claimId: content.claims[0]!.id,
          action: 'reject',
          correction: '',
        }),
      ).rejects.toThrow(/changed/)
      const published = await runtime.publishProfile({ generationId: id, expectedRevision: reviewed.revision })
      expect(published.content.claims).toHaveLength(1)
      expect(published.content.claims[0]!.assessment).toBe('recent_practice')
      expect(runtime.profileState().published?.id).toBe(published.id)
      expect((await runtime.publishProfile({ generationId: id, expectedRevision: reviewed.revision })).id).toBe(
        published.id,
      )
      await expect(
        runtime.reviewClaim({
          generationId: id,
          expectedRevision: reviewed.revision,
          claimId: content.claims[0]!.id,
          action: 'reject',
          correction: '',
        }),
      ).rejects.toThrow(/immutable/)
      await h.store.close()
      const reopened = await harness(h.root)
      try {
        expect(reopened.store.domain.table('control').get('current')?.publishedId).toBe(published.id)
      } finally {
        await reopened.close(false)
      }
    } finally {
      await runtime.close()
      await h.close()
    }
  })
})
