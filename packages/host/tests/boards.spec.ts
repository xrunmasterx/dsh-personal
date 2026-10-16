import { describe, expect, it, vi } from 'vitest'
import { normalizeIssuePage, WorkbenchBoards } from '../src/boards.ts'
import { responseData } from '../src/connectors/mcp.ts'
import type { CrashQuery } from '../src/models.ts'
import { config } from './helpers.ts'

const query: CrashQuery = {
  appId: 'app',
  platformId: 10,
  from: 1_780_000_000_000,
  to: 1_780_003_600_000,
  version: 'v1',
  keyword: 'Renderer',
  issueId: '',
  status: 2,
  offset: 10,
}

describe('TAPD board reads', () => {
  it('loads the token owner\'s cross-project todos without applying the investigation allowlist', async () => {
    const boards = new WorkbenchBoards(config(process.cwd()), { resolve: async () => undefined })
    const execute = vi.fn(async (tool: string) => ({
      content: [],
      structuredContent:
        tool === 'user_todo_stories_get'
          ? [
            { id: 'story-a', workspace_id: 20427626, title: 'ProjectFL story', status: 'open' },
            { id: 'story-b', workspace_id: '30000001', title: 'J3 story', status: 'open' },
          ]
          : tool === 'user_todo_bugs_get'
            ? [{ id: 'bug-a', workspace_id: '20427626', title: 'ProjectFL bug', status: 'new' }]
            : [],
    }))
    const disconnect = vi.fn(async () => {})
    vi.spyOn(boards, 'sessions').mockReturnValue({
      openTapd: async () => ({ execute, disconnect }),
      openCrashSight: async () => { throw new Error('Unexpected CrashSight request') },
    })

    const snapshot = await boards.tapd(new AbortController().signal)

    expect(execute.mock.calls).toEqual([
      ['user_todo_stories_get', {}],
      ['user_todo_bugs_get', {}],
      ['user_todo_tasks_get', {}],
    ])
    expect(snapshot.workspaceIds).toEqual(['20427626', '30000001'])
    expect(snapshot.counts).toEqual({ stories: 2, bugs: 1, tasks: 0 })
    expect(snapshot.items.map(item => item.key)).toEqual([
      'tapd:20427626:story:story-a',
      'tapd:30000001:story:story-b',
      'tapd:20427626:bug:bug-a',
    ])
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects an unscoped todo row without its owning workspace', async () => {
    const boards = new WorkbenchBoards(config(process.cwd()), { resolve: async () => undefined })
    const disconnect = vi.fn(async () => {})
    vi.spyOn(boards, 'sessions').mockReturnValue({
      openTapd: async () => ({
        execute: async tool => ({
          content: [],
          structuredContent: tool === 'user_todo_stories_get'
            ? [{ id: 'story-a', title: 'Missing workspace', status: 'open' }]
            : [],
        }),
        disconnect,
      }),
      openCrashSight: async () => { throw new Error('Unexpected CrashSight request') },
    })

    await expect(boards.tapd(new AbortController().signal)).rejects.toThrow(/workspace_id/)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})

describe('CrashSight board reads', () => {
  it.each(['trendList', 'trendData'])('reads %s trend points without mixing applications or platforms', async (field) => {
    const boards = new WorkbenchBoards(config(process.cwd()), { resolve: async () => undefined })
    const execute = vi.fn(async () => ({ content: [], structuredContent: { code: 200, errorCode: '', data: [
      { issueId: 'issue', [field]: [
        { appId: 'app', platformId: 10, date: '20260529', crashNum: 5, crashUser: 2 },
        { appId: 'app', platformId: 2, date: '20260529', crashNum: 100, crashUser: 10 },
        { appId: 'other', platformId: 10, date: '20260529', crashNum: 100, crashUser: 10 },
      ] },
    ] } }))
    const disconnect = vi.fn(async () => {})
    vi.spyOn(boards, 'sessions').mockReturnValue({
      openCrashSight: async () => ({ execute, disconnect }),
      openTapd: async () => { throw new Error('Unexpected TAPD request') },
    })
    expect(await boards.trend(query, 'issue', new AbortController().signal))
      .toEqual([{ date: '2026-05-29', reports: 5, devices: 2 }])
    expect(execute).toHaveBeenCalledWith('query_issue_trend', {
      appId: 'app', issueIds: ['issue'], minDate: '2026-05-29 04:26:40', maxDate: '2026-05-29 05:26:40',
      granularityUnit: 'DAY', granularityMagnitude: 1, version: 'v1',
    })
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed and failed trend responses instead of displaying an empty history', async () => {
    const boards = new WorkbenchBoards(config(process.cwd()), { resolve: async () => undefined })
    const execute = vi.fn()
      .mockResolvedValueOnce({ content: [], structuredContent: { code: 200, data: [{ issueId: 'issue' }] } })
      .mockResolvedValueOnce({ content: [], structuredContent: { code: 403, data: [] } })
    const disconnect = vi.fn(async () => {})
    vi.spyOn(boards, 'sessions').mockReturnValue({
      openCrashSight: async () => ({ execute, disconnect }),
      openTapd: async () => { throw new Error('Unexpected TAPD request') },
    })
    await expect(boards.trend(query, 'issue', new AbortController().signal)).rejects.toThrow(/no trend points/)
    await expect(boards.trend(query, 'issue', new AbortController().signal)).rejects.toThrow(/rejected/)
    expect(disconnect).toHaveBeenCalledTimes(2)
  })

  it('advances by received rows when the provider returns a shorter page and retains unknown counts', () => {
    const page = normalizeIssuePage(
      {
        numFound: 30,
        issueList: [
          { issueId: 'a', exceptionName: 'GPUCrash' },
          { issueId: 'b', crashNum: '7' },
        ],
      },
      query,
      'account',
    )
    expect(page.nextOffset).toBe(12)
    expect(page.items[0]!.reports).toBeNull()
    expect(page.items[1]!.reports).toBe(7)
    expect(page.items[0]!.key).toBe('account:issue:app:10:a')
    expect(() => normalizeIssuePage({ numFound: 30, issueList: [] }, query, 'account')).toThrow(/empty page/)
  })

  it('passes the fixed Issue filter through Report pagination and retains separate IDs', async () => {
    const boards = new WorkbenchBoards(config(process.cwd()), { resolve: async () => undefined })
    const execute = vi.fn(async () => ({
      content: [],
      structuredContent: {
        code: 200,
        errorCode: '',
        ret: { numFound: 12, crashDatas: { lookup: { crashId: 'attachment', productVersion: 'v1' } } },
      },
    }))
    const disconnect = vi.fn(async () => {})
    vi.spyOn(boards, 'sessions').mockReturnValue({
      openCrashSight: async () => ({ execute, disconnect }),
      openTapd: async () => {
        throw new Error('Unexpected TAPD request')
      },
    })
    const page = await boards.reports(query, 'issue', new AbortController().signal)
    expect(execute).toHaveBeenCalledWith('query_crash_list', {
      appId: 'app',
      platformId: 10,
      crashUploadTimeStart: query.from,
      crashUploadTimeEnd: query.to,
      version: ['v1'],
      crashDetailKeyword: 'Renderer',
      issueId: ['issue'],
      start: 10,
      rows: 2,
      desc: true,
    })
    expect(page.items[0]).toMatchObject({ crashHash: 'lookup', crashId: 'attachment', version: 'v1' })
    expect(page.nextOffset).toBe(11)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(() => responseData({ code: 200, errorCode: 'AUTH_REQUIRED', ret: {} })).toThrow(/rejected/)
  })
})
