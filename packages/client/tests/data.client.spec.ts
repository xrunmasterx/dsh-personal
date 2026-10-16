import { describe, expect, it, vi } from 'vitest'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CrashQuery,
  InvestigationPlan,
  ReportPage,
  RunPage,
  RunQuery,
  ProfileView,
  ProfileId,
  WorkbenchInfo,
} from '@xrunmasterx/dsh-personal-api/client'
import { WorkbenchClient } from '../src/client/data.ts'

const query: CrashQuery = {
  appId: 'a',
  platformId: 10,
  from: 1,
  to: 2,
  version: 'v1',
  keyword: '',
  issueId: '',
  status: null,
  offset: 0,
}

describe('workbench request ownership', () => {
  it('loads only the visible page and polls tokens instead of idle history bodies', async () => {
    vi.useFakeTimers()
    const info: WorkbenchInfo = {
      connectionId: 'test',
      projectName: 'ExampleProject',
      sourceRoot: '/source',
      tapdConfigured: true,
      crashSightConfigured: true,
      tapdWorkspaceIds: [],
      apps: [],
      investigationModel: 'fixture',
      profileModel: 'fixture',
      pageSize: 2,
      maxCases: 2,
      queryWindowDays: 7,
      pollIntervalMs: 3000,
      idlePollIntervalMs: 30000,
      cacheTtlMs: 300000,
    }
    const remote = {
      describe: vi.fn(async () => ({ ok: true, value: info })),
      changes: vi.fn(async () => ({
        ok: true,
        value: { revisions: { tapd: '1', runs: '1' }, activeRuns: [], activeProfiles: [] },
      })),
      tapdSnapshot: vi.fn(async () => ({ ok: true, value: { snapshot: null, lastError: null, lastAttemptAt: null } })),
      listRuns: vi.fn(async (query: RunQuery) => ({
        ok: true,
        value: { query, items: [], total: 0, nextOffset: null },
      })),
      profileState: vi.fn(),
    }
    const client = new WorkbenchClient(remote as unknown as ClientRemote['personalWorkbench'])
    try {
      await client.initialize()
      expect(remote.listRuns).not.toHaveBeenCalled()
      expect(remote.profileState).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(30000)
      expect(remote.changes).toHaveBeenCalledTimes(2)
      expect(remote.tapdSnapshot).toHaveBeenCalledTimes(1)
      client.activate('runs')
      await vi.advanceTimersByTimeAsync(0)
      expect(remote.listRuns).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60000)
      expect(remote.listRuns).toHaveBeenCalledTimes(1)
      for (const page of ['chat', 'board', 'reflection'] as const) {
        const calls = remote.changes.mock.calls.length
        client.activate(page)
        await vi.advanceTimersByTimeAsync(60000)
        expect(remote.changes).toHaveBeenCalledTimes(calls)
      }
      client.activate('tapd')
      await vi.advanceTimersByTimeAsync(0)
      expect(remote.tapdSnapshot).toHaveBeenCalledTimes(2)
    } finally {
      client.close()
      vi.useRealTimers()
    }
  })

  it('keeps the newest history filter and profile selection when older reads finish late', async () => {
    const oldRuns = Promise.withResolvers<RemoteResult<RunPage>>()
    const oldProfile = Promise.withResolvers<RemoteResult<ProfileView>>()
    const query: RunQuery = { offset: 0, target: null, mode: 'all', status: 'all', text: 'old' }
    const latest = { ...query, text: 'new' }
    const selected = '00000000-0000-4000-8000-000000000002' as ProfileId
    const profile: ProfileView = {
      selectedDraftId: selected,
      selectedDraftPublication: null,
      evidence: null,
      evidenceCheckedAt: null,
      published: null,
      drafts: [],
      versions: [],
      draftTotal: 0,
      versionTotal: 0,
      draftOffset: 0,
      versionOffset: 0,
      nextDraftOffset: null,
      nextVersionOffset: null,
    }
    const client = new WorkbenchClient({
      listRuns: vi
        .fn()
        .mockImplementationOnce(() => oldRuns.promise)
        .mockResolvedValue({ ok: true, value: { query: latest, items: [], total: 0, nextOffset: null } }),
      profileState: vi
        .fn()
        .mockImplementationOnce(() => oldProfile.promise)
        .mockResolvedValue({ ok: true, value: profile }),
    } as unknown as ClientRemote['personalWorkbench'])
    try {
      const first = client.loadRuns(query)
      const old = client.loadProfile(null, 0, 0)
      await client.loadRuns(latest)
      await client.loadProfile(selected, 0, 0)
      oldRuns.resolve({ ok: true, value: { query, items: [], total: 99, nextOffset: 2 } })
      oldProfile.resolve({ ok: true, value: { ...profile, selectedDraftId: null } })
      await Promise.all([first, old])
      expect(client.data.getSnapshot().runPage?.query.text).toBe('new')
      expect(client.data.getSnapshot().profile?.selectedDraftId).toBe(selected)
      expect(client.data.getSnapshot().busy).toEqual([])
    } finally {
      client.close()
    }
  })
  it('discards a Report response after the Issue query changes', async () => {
    const pending = Promise.withResolvers<RemoteResult<ReportPage>>()
    const remote = {
      listReports: vi.fn(() => pending.promise),
      searchIssues: vi.fn(async () => ({
        ok: true,
        value: { query, items: [], total: 0, nextOffset: null, fetchedAt: '' },
      })),
    } as unknown as ClientRemote['personalWorkbench']
    const client = new WorkbenchClient(remote)
    try {
      const reports = client.reports(query, 'old-issue')
      await client.search({ ...query, version: 'v2' })
      pending.resolve({ ok: true, value: { query, issueId: 'old-issue', items: [], total: 0, nextOffset: null } })
      await reports
      expect(client.data.getSnapshot().reports).toBeNull()
    } finally {
      client.close()
    }
  })

  it('does not restore a preview after its dialog is closed', async () => {
    const pending = Promise.withResolvers<RemoteResult<InvestigationPlan>>()
    const client = new WorkbenchClient({
      createPlan: () => pending.promise,
    } as unknown as ClientRemote['personalWorkbench'])
    try {
      const request = client.prepare({
        target: { kind: 'tapd', url: 'https://tapd.woa.com/a' },
        mode: 'single',
        samples: [],
        additionalContext: '',
      })
      client.clearPlan()
      pending.resolve({ ok: true, value: { id: 'closed-preview' } as InvestigationPlan })
      await request
      expect(client.data.getSnapshot().plan).toBeNull()
    } finally {
      client.close()
    }
  })
})
