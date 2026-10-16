// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'

import type { RunId } from '@xrunmasterx/dsh-personal-api/client'
import { Tickets } from '../src/client/Tickets.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce((copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)), zh[key])
) as ComponentProps<typeof Tickets>['t']

function props(): ComponentProps<typeof Tickets> {
  return {
    t, mode: 'tapd', navigate: vi.fn(), investigate: vi.fn(), history: vi.fn(),
    callbacks: { refreshTapd: vi.fn(), loadLinkedCrashes: vi.fn(), assist: vi.fn() },
    data: {
      info: { connectionId: 'test', projectName: 'ExampleProject', sourceRoot: '/source', tapdConfigured: true,
        crashSightConfigured: true, tapdWorkspaceIds: ['1'], apps: [], investigationModel: 'fixture',
        profileModel: 'fixture', pageSize: 1, maxCases: 2, queryWindowDays: 7, pollIntervalMs: 3000,
        idlePollIntervalMs: 30000, cacheTtlMs: 300000 },
      tapd: { lastError: null, lastAttemptAt: null, snapshot: {
        workspaceIds: ['1', '2'], fetchedAt: '2026-09-08T02:00:00Z', cacheExpiresAt: '2026-09-08T03:00:00Z',
        counts: { bugs: 2, stories: 1, tasks: 0 }, total: 3,
        items: [
          { key: 'bug-1', kind: 'bug', id: '11', workspaceId: '1', title: 'GPU crash', status: '新', owner: 'Owner' },
          { key: 'story-2', kind: 'story', id: '22', workspaceId: '2', title: 'Lighting plan', status: '实现中' },
          { key: 'bug-3', kind: 'bug', id: '33', workspaceId: '2', title: 'Other crash', status: '新' },
        ],
      } },
      linkedCrashes: { query: { offset: 0, text: '' }, total: 2, nextOffset: 1,
        summary: { tapdItems: 2, issues: 2, reports: 3 }, items: [{
          key: 'link-1', tapd: { id: '11', url: 'https://tapd.woa.com/tapd_fe/1/bug/detail/11',
            title: 'GPU crash', status: '新', priority: null, owner: 'Owner', current: false },
          crash: { appId: 'app', platformId: 10, issueId: 'issue-1', reportCount: 2, versions: ['1.0'] },
          runCount: 1, latestRun: { id: 'run-1' as RunId, status: 'completed', mode: 'single',
            createdAt: '2026-09-08T02:00:00Z' },
        }] },
      runs: [], runPage: null, selectedRun: null, profile: null, publication: null, changes: null,
      issueDetails: null, result: null, evidence: null, storage: null, cleanup: null, cleaned: null,
      issues: null, reports: null, plan: null, report: null, busy: [], error: null,
    },
  }
}

afterEach(cleanup)

describe('unified ticket views', () => {
  it('presents one source header and compact disclosures before exposing actions', () => {
    render(<Tickets {...props()} />)
    const visible = [...document.querySelectorAll('h1, summary')].filter(el => !el.closest('[hidden]'))
    expect(visible.map(el => el.textContent)).toMatchInlineSnapshot(`
      [
        "单据",
        "?",
        "筛选",
        "缺陷新GPU crash",
        "需求实现中Lighting plan",
        "缺陷新Other crash",
      ]
    `)
    // JSDOM does not apply native closed-details visibility to role queries.
    for (const action of screen.getAllByRole('button', { name: zh['journal.sourceAction'] })) {
      expect(action.closest('details')?.open).toBe(false)
    }
  })

  it('keeps work filters and expanded rows when switching views', () => {
    const p = props()
    const view = render(<Tickets {...p} />)
    fireEvent.change(screen.getByRole('searchbox', { name: zh.filter }), { target: { value: 'GPU' } })
    const row = screen.getAllByText('GPU crash').find(el => !el.closest('[hidden]'))!.closest('details')!
    fireEvent.click(row.querySelector('summary')!)
    expect(row.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['tickets.crash'] }))
    expect(p.navigate).toHaveBeenCalledWith('crash')
    view.rerender(<Tickets {...p} mode="crash" />)
    expect(screen.queryByRole('searchbox', { name: zh.filter })).toBeNull()
    view.rerender(<Tickets {...p} />)
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: zh.filter }).value).toBe('GPU')
    expect(row.open).toBe(true)
    expect(p.callbacks.refreshTapd).not.toHaveBeenCalled()
    expect(p.callbacks.loadLinkedCrashes).not.toHaveBeenCalled()
  })

  it('combines category, workspace, status and text filters without limiting collection scope', () => {
    render(<Tickets {...props()} />)
    fireEvent.click(screen.getByRole('button', { name: /需求/ }))
    expect(screen.getByText('Lighting plan')).toBeTruthy()
    expect(screen.queryByText('Other crash')).toBeNull()
    fireEvent.click(screen.getByText(zh.filterAction, { selector: 'summary' }))
    fireEvent.change(screen.getByLabelText(zh.workspace), { target: { value: '1' } })
    expect(screen.getByText(zh.emptyTapd)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.clearFilters }))
    expect(screen.getByText('Lighting plan')).toBeTruthy()
    expect(screen.getByText('Other crash')).toBeTruthy()
  })

  it('retains planning for every kind and investigation only for configured defects', () => {
    const p = props()
    render(<Tickets {...p} />)
    // Scope each action to a particular disclosure because a hidden view retains its own rows.
    for (const title of ['GPU crash', 'Lighting plan', 'Other crash']) {
      const row = [...document.querySelectorAll('details')].find(el =>
        !el.closest('[hidden]') && el.querySelector('summary')?.textContent?.includes(title),
      )!
      fireEvent.click(row.querySelector('summary')!)
      fireEvent.click(within(row).getByRole('button', { name: zh['journal.sourceAction'] }))
      if (title === 'GPU crash') {
        fireEvent.click(within(row).getByRole('button', { name: zh.investigate }))
      } else {
        expect(within(row).queryByRole('button', { name: zh.investigate })).toBeNull()
      }
    }
    expect(p.callbacks.assist).toHaveBeenCalledTimes(3)
    expect(p.investigate).toHaveBeenCalledWith({ kind: 'tapd', url: 'https://tapd.woa.com/tapd_fe/1/bug/detail/11' }, [])
  })

  it('opens the selected defect associations with the ticket ID rather than a partial client-side join', () => {
    const p = props()
    const view = render(<Tickets {...p} />)
    const row = screen.getAllByText('GPU crash').find(el => !el.closest('[hidden]'))!.closest('details')!
    fireEvent.click(row.querySelector('summary')!)
    fireEvent.click(within(row).getByRole('button', { name: zh['tickets.showLinks'] }))
    expect(p.callbacks.loadLinkedCrashes).toHaveBeenCalledWith({ offset: 0, text: '11' })
    expect(p.navigate).toHaveBeenCalledWith('crash')
    view.rerender(<Tickets {...p} mode="crash" />)
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: zh.filterLinked }).value).toBe('11')
    expect(screen.getByText(zh.historicalLink)).toBeTruthy()
  })

  it('searches from the first page and preserves the committed query when paging or refreshing', () => {
    const p = props()
    p.data.linkedCrashes!.query.text = 'committed'
    render(<Tickets {...p} mode="crash" />)
    fireEvent.change(screen.getByRole('searchbox', { name: zh.filterLinked }), { target: { value: ' new ' } })
    fireEvent.click(screen.getByRole('button', { name: zh.next }))
    expect(p.callbacks.loadLinkedCrashes).toHaveBeenLastCalledWith({ offset: 1, text: 'committed' })
    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    expect(p.callbacks.loadLinkedCrashes).toHaveBeenLastCalledWith({ offset: 0, text: 'committed' })
    fireEvent.click(screen.getByRole('button', { name: zh.search }))
    expect(p.callbacks.loadLinkedCrashes).toHaveBeenLastCalledWith({ offset: 0, text: 'new' })
    fireEvent.click(screen.getByRole('button', { name: zh.clearFilters }))
    expect(p.callbacks.loadLinkedCrashes).toHaveBeenLastCalledWith({ offset: 0, text: '' })
  })
})
