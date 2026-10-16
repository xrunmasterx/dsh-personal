import { describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '../src/artifacts.ts'
import { WorkbenchBoards } from '../src/boards.ts'
import { investigate } from '../src/incident/pipeline.ts'
import { mechanismInvestigationDraftSchema } from '../src/incident/schema.ts'
import type { ModelRequest } from '../src/executor.ts'
import { harness, mcpSessions, runRecord, sample } from './helpers.ts'
import { join } from 'node:path'
import { RunBudget } from '../src/storage.ts'

describe('incident execution', () => {
  it('finishes every mechanism before attribution and keeps each Case and handoff isolated', async () => {
    const h = await harness()
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    vi.spyOn(boards, 'sessions').mockImplementation(() => mcpSessions(calls))
    const seen: ModelRequest[] = []
    const artifacts = new ArtifactStore(join(h.root, 'artifacts'), h.config.maxResultBytes)
    const run = {
      ...runRecord(),
      mode: 'dual' as const,
      sourceRoot: h.root,
      samples: [sample, { ...sample, crashHash: 'report-b', crashId: 'native-b' }],
    }
    const progress = vi.fn(async () => {})
    try {
      const result = await investigate({
        run,
        prepared: { ticket: null, ticketEvidence: [] },
        config: h.config,
        budget: new RunBudget(h.config.storage.maxRunBytes, 0),
        boards,
        artifacts,
        signal: new AbortController().signal,
        progress,
        execute: async (request) => {
          seen.push(request)
          const report = seen.length % 2 === 1 ? 'report-a' : 'report-b'
          const common = {
            caseId: `test:crash:app:10:${report}`,
            incidentKind: 'crash',
            causalDepth: 'reporting_site',
            oneSentenceConclusion: `观察到 ${report}`,
            summary: `独立材料 ${report}`,
            crashSite: 'Renderer',
            trigger: null,
            codeLocations: [],
            fileReviews: [],
            causalChain: [{ statement: '已观察到崩溃', evidenceLevel: 'observed', evidenceRefs: [] }],
            limitations: ['尚无根因证据'],
          }
          return request.schema === mechanismInvestigationDraftSchema
            ? { ...common, violatedContract: `handoff-${report}` }
            : {
              ...common,
              conclusionLevel: '范围定位',
              confidence: 0.5,
              rootCauseOwner: 'unknown',
              rootCauseAnalysis: null,
              hypotheses: [],
              nextActions: ['收集更多证据'],
            }
        },
      })
      expect(
        seen.map(request => (request.schema === mechanismInvestigationDraftSchema ? 'mechanism' : 'attribution')),
      ).toEqual(['mechanism', 'mechanism', 'attribution', 'attribution'])
      expect(new Set(seen.map(request => request.name)).size).toBe(4)
      expect(seen[0]!.prompt).not.toContain('report-b')
      expect(seen[1]!.prompt).not.toContain('report-a')
      expect(seen[2]!.prompt).toContain('handoff-report-a')
      expect(seen[2]!.prompt).not.toContain('handoff-report-b')
      expect(result.cases.map(item => item.caseInput.case.reportId)).toEqual(['report-a', 'report-b'])
      expect(result.markdown).toContain('观察到')
      expect(calls.some(call => call.tool === 'fetch_last_crash_detail_in_issue')).toBe(false)
      expect([
        ...new Set(calls.filter(call => call.tool === 'get_report_attachments').map(call => call.args.crashId)),
      ]).toEqual(['native-report-a', 'native-report-b'])
      expect((await artifacts.register(run.id, 'report', 'report.md')).sizeBytes).toBeGreaterThan(0)
    } finally {
      await h.close()
    }
  })

  it('does not start a model when an approved Report becomes unavailable', async () => {
    const h = await harness()
    const boards = new WorkbenchBoards(h.config, { resolve: async () => undefined })
    const sessions = mcpSessions([])
    vi.spyOn(boards, 'sessions').mockReturnValue({
      ...sessions,
      openCrashSight: async () => ({
        disconnect: async () => {},
        execute: async () => ({ content: [], structuredContent: { code: 200, ret: { exists: false } } }),
      }),
    })
    const execute = vi.fn()
    try {
      await expect(
        investigate({
          run: runRecord(),
          prepared: { ticket: null, ticketEvidence: [] },
          config: h.config,
          budget: new RunBudget(h.config.storage.maxRunBytes, 0),
          boards,
          artifacts: new ArtifactStore(join(h.root, 'artifacts'), h.config.maxResultBytes),
          execute,
          signal: new AbortController().signal,
          progress: async () => {},
        }),
      ).rejects.toThrow()
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})
