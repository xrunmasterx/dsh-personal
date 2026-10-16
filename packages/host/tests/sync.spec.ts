import { describe, expect, it, vi } from 'vitest'
import { WorkbenchBoards } from '../src/boards.ts'
import { WorkbenchRuntime } from '../src/runtime.ts'
import type { TapdTodoSnapshot } from '../src/tapd/schema.ts'
import { harness, mcpSessions, sample, tapdUrl } from './helpers.ts'

function snapshot(): TapdTodoSnapshot {
  const now = Date.now()
  return {
    workspaceIds: ['12345678'],
    items: [],
    counts: { bugs: 0, stories: 0, tasks: 0 },
    total: 0,
    fetchedAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(now + 300_000).toISOString(),
  }
}

describe('workbench source freshness', () => {
  it('shares overlapping TAPD and profile refreshes and reuses unchanged material snapshots', async () => {
    const h = await harness()
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    const pending = Promise.withResolvers<TapdTodoSnapshot>()
    const read = vi.spyOn(boards, 'tapd').mockImplementation(() => pending.promise)
    const execute = vi.fn()
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, { boards, execute })
    try {
      const one = runtime.refreshTapd()
      const two = runtime.refreshTapd()
      const profile = runtime.refreshEvidence()
      const sameProfile = runtime.refreshEvidence()
      expect(read).toHaveBeenCalledTimes(1)
      pending.resolve(snapshot())
      const [first, second, material, shared] = await Promise.all([one, two, profile, sameProfile])
      expect(first).toEqual(second)
      expect(material.id).toBe(shared.id)
      read.mockImplementation(async () => snapshot())
      const repeated = await runtime.refreshEvidence()
      expect(repeated.id).toBe(material.id)
      expect([...h.store.domain.table('evidence').entries()]).toHaveLength(1)
      expect(runtime.profileState().evidenceCheckedAt).toBeTruthy()
      const lastSuccess = runtime.tapdSnapshot().snapshot
      read.mockRejectedValue(new Error('offline'))
      const unavailable = await runtime.refreshEvidence()
      expect(unavailable.coverage.find(item => item.source === 'tapd')?.status).toBe('unavailable')
      expect(runtime.tapdSnapshot().snapshot).toEqual(lastSuccess)
      expect(runtime.tapdSnapshot().lastError).toContain('offline')
      expect(execute).not.toHaveBeenCalled()
      await h.store.domain
        .table('control')
        .update('current', current => ({ ...current, evidenceCheckedAt: '2000-01-01T00:00:00Z' }))
      await expect(runtime.generateProfile(unavailable.id)).rejects.toThrow(/过期/)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await h.close()
    }
  })

  it('refreshes expired TAPD data when maintenance starts without invoking a model', async () => {
    const h = await harness()
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    const read = vi.spyOn(boards, 'tapd').mockImplementation(async () => snapshot())
    const execute = vi.fn()
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, { boards, execute })
    try {
      runtime.startMaintenance()
      await vi.waitFor(() => {
        expect(runtime.tapdSnapshot().snapshot).not.toBeNull()
      })
      expect(read).toHaveBeenCalledTimes(1)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await h.close()
    }
  })

  it('reruns a TAPD investigation against its pinned Report even when the ticket links a newer one', async () => {
    const h = await harness()
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    vi.spyOn(boards, 'sessions').mockImplementation(() => mcpSessions(calls))
    const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, { boards, execute: vi.fn() })
    try {
      const old = { ...sample, crashHash: 'previous-report', crashId: 'native-previous-report' }
      const plan = await runtime.createPlan({
        target: { kind: 'tapd', url: tapdUrl },
        samples: [old],
        mode: 'dual',
        additionalContext: '保留背景',
      })
      expect(plan.samples.map(item => item.crashHash)).toEqual(['previous-report'])
      expect(plan.mode).toBe('dual')
      expect(calls.filter(item => item.tool === 'get_report_detail').map(item => item.args.crashHash)).toEqual([
        'previous-report',
      ])
      expect(calls.some(item => item.tool === 'fetch_last_crash_detail_in_issue')).toBe(false)
    } finally {
      await runtime.close()
      await h.close()
    }
  })
})
