// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComponentProps } from 'react'
import type {
  JournalId,
  JournalRow,
  JournalQuery,
  JournalWrite,
  TaskSessionId,
} from '@xrunmasterx/dsh-personal-host/client'
import { Journal, type JournalActions } from '../src/client/Journal.tsx'
import { zh } from '../src/client/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

const t = ((key: keyof typeof zh, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (copy, [name, value]) => copy.replaceAll(`{${name}}`, String(value)),
    zh[key],
  )) as ComponentProps<typeof Journal>['t']
const sessions: SessionListState = {
  ids: [],
  byId: {},
  current: undefined,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}
const row: JournalRow = {
  revision: 1,
  eventId: '00000000-0000-4000-8000-000000000001' as JournalId,
  item: {
    id: '00000000-0000-4000-8000-000000000002' as JournalId,
    title: 'Reflection work',
    status: 'todo',
    plans: [],
    links: [],
    nextAction: '',
    createdOn: '2026-09-07',
  },
}
function api(initial = row): JournalActions {
  let current = structuredClone(initial)
  return {
    journalQuery: vi.fn(async (query: JournalQuery) => ({
      items: query.text && !current.item.title.includes(query.text) ? [] : [current],
      nextOffset: null,
      total: 1,
    })),
    journalActivity: vi.fn(async () => ({ events: [], revertedIds: [], nextOffset: null })),
    journalReport: vi.fn(async () => ({ report: null, stale: false })),
    journalHistory: vi.fn(async () => ({ events: [], nextOffset: null })),
    journalWrite: vi.fn(async (request: JournalWrite) => {
      const before = current.item
      const plans =
        request.operation === 'unplan'
          ? before.plans.filter(p => p.day !== request.day)
          : request.plan
            ? [
              ...before.plans.filter(p => p.day !== request.replaceDay && p.day !== request.plan?.day),
              request.plan,
            ]
            : before.plans
      current = {
        ...current,
        revision: current.revision + 1,
        item: {
          ...before,
          ...(request.title !== undefined ? { title: request.title } : {}),
          plans,
          status: request.status ?? before.status,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.summary !== undefined ? { summary: request.summary } : {}),
          ...(request.taskSession
            ? {
              sessions: [
                ...(before.sessions ?? []).filter(link => link.id !== request.taskSession?.id),
                { ...request.taskSession, provider: 'dsh' as const, createdAt: '2026-09-08T00:00:00Z' },
              ],
            }
            : {}),
          ...(request.timeline ? { timeline: request.timeline } : {}),
        },
        ...(request.status === 'active'
          ? {
            execution: {
              startedAt: new Date().toISOString(),
              startedOn: request.day,
              endedAt: null,
              endedOn: null,
            },
          }
          : {}),
      }
      return {
        id: row.eventId,
        itemId: row.item.id,
        revision: current.revision,
        at: '2026-09-07T00:00:00Z',
        day: request.day,
        operation: request.operation,
        before,
        after: current.item,
        log: null,
        reason: 'explicit',
        reverts: null,
        requestHash: '',
      }
    }),
    journalWeek: vi.fn(),
    journalSaveReport: vi.fn(),
    journalEvent: vi.fn(),
    journalUploadImage: vi.fn(async () => 'personal-image:v1:fixture'),
    journalReadImage: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
    polishBrief: vi.fn(async (text: string) => ({ what: text, why: '', progress: '', summary: '' })),
    assist: vi.fn(async () => {}),
    archiveTaskSession: vi.fn(async () => {}),
    beginBoardSession: vi.fn(async () => {}),
    beginTaskSession: vi.fn(async () => () => {}),
    openTaskSession: vi.fn(async () => {}),
  }
}
async function board(callbacks: JournalActions, openBacklog = true) {
  render(
    <Journal
      page="board"
      api={callbacks}
      t={t}
      pollIntervalMs={60_000}
      archivedSessionIds={[]}
      sessions={sessions}
      onTaskDetail={() => {}}
    />,
  )
  await waitFor(() => {
    expect(screen.queryByText(zh.loading)).toBeNull()
  })
  if (openBacklog) fireEvent.click(screen.getByRole('button', { name: /积压事项 ·/ }))
}
function drag(card: HTMLElement, target: HTMLElement) {
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(card, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })
  fireEvent.dragEnd(card, { dataTransfer })
}
afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('backlog and execution Gantt', () => {
  it('previews one brief inline without selecting an agent task and keeps controls independent', async () => {
    const first = { ...row, item: { ...row.item, status: 'active' as const, description: '## Preview heading\nDetailed content\n![Screenshot](personal-image:v1:fixture)' } }
    const second = { ...first, item: { ...first.item, id: 'second-task' as JournalId, title: 'Second task', description: '' } }
    const callbacks = api(first)
    vi.mocked(callbacks.journalQuery).mockResolvedValue({ items: [first, second], total: 2, nextOffset: null })
    await board(callbacks, false)
    const article = screen.getByRole('article', { name: first.item.title })
    fireEvent.click(within(article).getByText(first.item.title))
    expect(screen.getByRole('heading', { name: 'Preview heading' })).toBeTruthy()
    await waitFor(() => expect(callbacks.journalReadImage).toHaveBeenCalledWith('personal-image:v1:fixture'))
    expect(callbacks.beginTaskSession).not.toHaveBeenCalled()
    fireEvent.click(within(article).getByLabelText(zh['gantt.more']))
    expect(screen.getByRole('heading', { name: 'Preview heading' })).toBeTruthy()
    fireEvent.click(screen.getByText(second.item.title))
    expect(screen.queryByRole('heading', { name: 'Preview heading' })).toBeNull()
    expect(screen.getByText(zh['task.emptyBrief'])).toBeTruthy()
    fireEvent.click(screen.getByText(second.item.title))
    expect(screen.queryByText(zh['task.emptyBrief'])).toBeNull()
    fireEvent.click(within(article).getByRole('button', { name: t('planner.toggleBrief', { title: first.item.title }) }))
    expect(screen.getByRole('heading', { name: 'Preview heading' })).toBeTruthy()
    fireEvent.click(within(article).getByRole('button', { name: zh['planner.details'] }))
    await waitFor(() => expect(callbacks.beginTaskSession).toHaveBeenCalled())
  })

  it.each([true, false])('restores persisted following=%s on a later day', async (followToday) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-18T12:00:00'))
    await board(api({ ...row, item: { ...row.item, status: 'active', timeline: { from: '2026-09-14', to: '2026-09-17', followToday } },
      execution: { startedOn: '2026-09-14', startedAt: '2026-09-14T00:00:00Z', endedOn: null, endedAt: null } }))
    expect(screen.getByText(followToday ? '09-14 — 09-18' : '09-14 — 09-17')).toBeTruthy()
  })

  it('pauses away from today, resumes at today, and clamps pointer movement without losing handles', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T12:00:00'))
    const callbacks = api({ ...row, item: { ...row.item, status: 'active' },
      execution: { startedOn: '2026-09-08', startedAt: '2026-09-08T00:00:00Z', endedOn: null, endedAt: null } })
    await board(callbacks)
    const handle = screen.getByRole('button', { name: t('gantt.resizeEnd', { title: row.item.title }) })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({ timeline: { from: '2026-09-08', to: '2026-09-16', followToday: false } })) })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenLastCalledWith(expect.objectContaining({ timeline: { from: '2026-09-08', to: '2026-09-17', followToday: true } })) })
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() })
    vi.spyOn(handle.closest('[data-track]')!, 'getBoundingClientRect').mockReturnValue({ width: 700 } as DOMRect)
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true }); Object.assign(event, { clientX: x, pointerId: 1 }); fireEvent(handle, event)
    }
    pointer('pointerdown', 300); pointer('pointermove', -900)
    expect(handle.isConnected).toBe(true)
    expect(screen.getByText('09-08 — 09-14')).toBeTruthy()
    pointer('pointermove', 1200)
    expect(screen.getByText('09-08 — 09-20')).toBeTruthy()
    fireEvent.keyDown(handle, { key: 'Escape' }); pointer('pointerup', 1200)
    expect(callbacks.journalWrite).toHaveBeenCalledTimes(2)
  })

  it('shows one automatic span regardless of old planned dates, and continues into the next week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T12:00:00'))
    const callbacks = api({ ...row,
      item: { ...row.item, status: 'active', timeline: { from: '2026-09-08', to: '2026-09-14' } },
      execution: { startedOn: '2026-09-09', startedAt: '2026-09-09T00:00:00Z', endedOn: null, endedAt: null },
    })
    await board(callbacks)
    const card = screen.getByRole('article', { name: row.item.title })
    expect(within(card).getByTitle('2026-09-09 — 2026-09-17').style.gridColumn).toBe('1 / span 4')
    expect(within(card).queryByText('09-08 — 09-14')).toBeNull()
    expect(within(card).getAllByRole('button', { name: /日期/ })).toHaveLength(2)
    expect(within(card).queryByText(/计划/)).toBeNull()
    vi.setSystemTime(new Date('2026-09-22T12:00:00'))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => {
      expect(screen.getByTitle('2026-09-09 — 2026-09-22').style.gridColumn).toBe('1 / span 2')
    })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['gantt.finish'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({ status: 'done', day: '2026-09-22' })) })
  })

  it('stops completed spans at their recorded end and preserves a historical week across rollover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T12:00:00'))
    await board(api({ ...row,
      item: { ...row.item, status: 'done', timeline: { from: '2026-09-01', to: '2026-09-30' } },
      execution: { startedOn: '2026-09-08', startedAt: '2026-09-08T00:00:00Z', endedOn: '2026-09-11', endedAt: '2026-09-11T00:00:00Z' },
    }))
    expect(screen.queryByRole('article', { name: row.item.title })).toBeNull()
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-07' } })
    fireEvent.click(screen.getByRole('button', { name: /本周已结束 ·/ }))
    expect(screen.getByTitle('2026-09-08 — 2026-09-11').style.gridColumn).toBe('2 / span 4')
    vi.setSystemTime(new Date('2026-09-22T12:00:00'))
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => { expect(screen.getByText('09-08 — 09-11')).toBeTruthy() })
    expect(screen.getByRole('article', { name: row.item.title }).textContent).toMatchInlineSnapshot('"已完成⋯上移下移移回积压⠿Reflection work09-08 — 09-11"')
  })

  it('prepares the selected board week again after returning from a task', async () => {
    const callbacks = api()
    await board(callbacks)
    await waitFor(() => { expect(callbacks.beginBoardSession).toHaveBeenCalledTimes(1) })
    const first = vi.mocked(callbacks.beginBoardSession).mock.calls[0]!
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    expect(first[1].aborted).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    await waitFor(() => { expect(callbacks.beginBoardSession).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(callbacks.beginBoardSession).mock.calls[1]![0]).toBe(first[0])
  })

  it('prepares once per task opening, cancels on close and leaves the journal unchanged until conversation starts', async () => {
    const callbacks = api()
    const release = vi.fn()
    vi.mocked(callbacks.beginTaskSession).mockResolvedValue(release)
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    await waitFor(() => { expect(callbacks.beginTaskSession).toHaveBeenCalledTimes(1) })
    const signal = vi.mocked(callbacks.beginTaskSession).mock.calls[0]![2]
    expect(callbacks.beginTaskSession).toHaveBeenCalledWith(row.item.id, row.item.title, signal)
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    expect(callbacks.beginTaskSession).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    expect(signal.aborted).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    await waitFor(() => { expect(callbacks.beginTaskSession).toHaveBeenCalledTimes(2) })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('shows document-derived card updates instead of stale next-action fields without a model call', async () => {
    const callbacks = api({ ...row, item: { ...row.item, status: 'active', nextAction: 'Obsolete separate instruction', description: '## 进展\n已观察：值已赋值，界面未显示' } })
    await board(callbacks)
    expect(screen.getByText('已观察：值已赋值，界面未显示')).toBeTruthy()
    expect(screen.queryByText('Obsolete separate instruction')).toBeNull()
    expect(callbacks.polishBrief).not.toHaveBeenCalled()
  })

  it('polishes edited content once, preserves work state and can restore the exact draft', async () => {
    const callbacks = api()
    let finish!: (value: { what: string; why: string; progress: string; summary: string }) => void
    vi.mocked(callbacks.polishBrief).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    expect(screen.getByRole('checkbox', { name: zh['task.autoPolish'] })).toHaveProperty('checked', true)
    expect(callbacks.polishBrief).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    const raw = '查 IBL。为了减少卡顿。还没验证，下一步跑测试。'
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: raw } })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: zh['task.brief'] }), { key: 'Enter', ctrlKey: true })
    expect(callbacks.polishBrief).toHaveBeenCalledTimes(1)
    expect(callbacks.polishBrief).toHaveBeenCalledWith(raw, 'polish', 'todo')
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh['task.polishing'] })).toHaveProperty('disabled', true)
    finish({ summary: '尚未验证；下一步运行测试。', what: '检查 IBL。', why: '减少卡顿。', progress: '尚未验证；下一步运行测试。' })
    await screen.findByText(zh['task.polished'])
    expect(screen.getAllByRole('heading').map(el => el.textContent)).toContain('进展')
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 1, title: row.item.title, summary: '尚未验证；下一步运行测试。',
      description: '## 任务内容\n\n检查 IBL。\n\n## 为什么做\n\n减少卡顿。\n\n## 进展\n\n尚未验证；下一步运行测试。',
    })
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].status).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: zh['task.restoreOriginal'] }))
    expect(screen.getByRole('textbox', { name: zh['task.brief'] })).toHaveProperty('value', raw)
    expect(screen.getByRole('checkbox', { name: zh['task.autoPolish'] })).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledTimes(2) })
    expect(callbacks.journalWrite).toHaveBeenLastCalledWith(expect.objectContaining({ description: raw, expectedRevision: 2 }))
    expect(callbacks.polishBrief).toHaveBeenCalledTimes(1)
  })

  it('retains the draft on polish failure and permits an unpolished retry', async () => {
    const callbacks = api()
    vi.mocked(callbacks.polishBrief).mockRejectedValue(new Error('timeout'))
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: 'still working' } })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh['task.polishFailed'])
    expect(screen.getByRole('textbox', { name: zh['task.brief'] })).toHaveProperty('value', 'still working')
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(`personal-workbench/task-draft/${row.item.id}`)).toContain('still working')
    fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledOnce() })
    expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({ description: 'still working' }))
  })

  it('keeps the source draft when a revision conflict rejects a polished save', async () => {
    const callbacks = api()
    vi.mocked(callbacks.journalWrite).mockRejectedValue(new Error('Revision conflict'))
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: 'my original note' } })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Revision conflict')
    expect(screen.getByRole('textbox', { name: zh['task.brief'] })).toHaveProperty('value', 'my original note')
    expect(callbacks.journalWrite).toHaveBeenCalledOnce()
  })

  it('keeps unsaved text after returning to the board and saves it with Ctrl+Enter', async () => {
    const callbacks = api()
    await board(callbacks)
    const open = () => fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    open()
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    expect(screen.getByRole('button', { name: zh['journal.save'] })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), {
      target: { value: 'Unfinished thought' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    open()
    const input = screen.getByRole('textbox', { name: zh['task.brief'] })
    expect(input).toHaveProperty('value', 'Unfinished thought')
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    await screen.findByText('Unfinished thought')
    expect(sessionStorage.getItem(`personal-workbench/task-draft/${row.item.id}`)).toBeNull()
  })

  it('accepts an unrelated revision change while editing without rejecting the document', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), {
      target: { value: 'New explanation' },
    })
    vi.mocked(callbacks.journalQuery).mockResolvedValue({
      items: [{ ...row, revision: 2 }],
      total: 1,
      nextOffset: null,
    })
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() =>{  expect(callbacks.journalQuery).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await waitFor(() =>{
      expect(callbacks.journalWrite).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 2, description: 'New explanation' }),
      ) },
    )
  })

  it('retains an open draft when the Agent publishes a newer revision', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), {
      target: { value: 'My unsaved reasoning' },
    })
    vi.mocked(callbacks.journalQuery).mockResolvedValue({
      items: [{ ...row, revision: 2, item: { ...row.item, description: 'New Agent findings' } }],
      total: 1,
      nextOffset: null,
    })
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText(zh['task.draftConflict'])
    expect(screen.getByRole('textbox', { name: zh['task.brief'] })).toHaveProperty(
      'value',
      'My unsaved reasoning',
    )
    expect(screen.getByRole('button', { name: zh['journal.save'] })).toHaveProperty('disabled', true)
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['task.discard'] }))
    await screen.findByText('New Agent findings')
  })

  it('saves a free-form brief without changing status or schedule', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), {
      target: { value: '## Why\n\nKeep reflections stable.' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await screen.findByText('Keep reflections stable.')
    expect(callbacks.journalWrite).toHaveBeenCalledWith(
      expect.objectContaining({ description: '## Why\n\nKeep reflections stable.', expectedRevision: 1 }),
    )
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].status).toBeUndefined()
  })

  it.each([true, false])('creates an untitled task with one LLM call (polish=%s)', async (polish) => {
    const callbacks = api()
    vi.mocked(callbacks.polishBrief).mockResolvedValue({ summary: '', title: '排查 Cubemap 设置失败', what: '蓝图设置失败。', why: '', progress: '尚未测试合规格式。' })
    await board(callbacks)
    fireEvent.click(screen.getByRole('button', { name: zh['task.new'] }))
    if (!polish) fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    const draft = '蓝图设置失败，还没测合规格式。'
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: draft } })
    expect(screen.getByRole('button', { name: zh['task.create'] })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: zh['task.create'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledOnce() })
    expect(callbacks.polishBrief).toHaveBeenCalledExactlyOnceWith(draft, polish ? 'both' : 'title', 'todo')
    expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create', title: '排查 Cubemap 设置失败',
      description: polish ? '## 任务内容\n\n蓝图设置失败。\n\n## 进展\n\n尚未测试合规格式。' : draft,
    }))
    expect(callbacks.openTaskSession).not.toHaveBeenCalled()
  })

  it('keeps an untitled draft on LLM failure and rejects entirely empty creation', async () => {
    const callbacks = api()
    vi.mocked(callbacks.polishBrief).mockRejectedValue(new Error('offline'))
    await board(callbacks)
    fireEvent.click(screen.getByRole('button', { name: zh['task.new'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: zh['task.create'] })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: 'my draft' } })
    fireEvent.click(screen.getByRole('button', { name: zh['task.create'] }))
    await screen.findByRole('alert')
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: zh['task.title'] })).toHaveProperty('value', '')
    expect(screen.getByRole('textbox', { name: zh['task.brief'] })).toHaveProperty('value', 'my draft')
  })

  it('creates a manual backlog item through the same title and document editor', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.click(screen.getByRole('button', { name: zh['task.new'] }))
    expect(screen.getByRole('button', { name: zh['task.create'] })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: zh['task.newSession'] })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.title'] }), { target: { value: 'Investigate a new idea' } })
    fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.brief'] }), { target: { value: '## Why\nExplore a better approach.' } })
    fireEvent.click(screen.getByRole('button', { name: zh['task.create'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledTimes(1) })
    expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'create', expectedRevision: 0, title: 'Investigate a new idea', description: '## Why\nExplore a better approach.',
    }))
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].nextAction).toBeUndefined()
    expect(callbacks.openTaskSession).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('personal-workbench/task-draft/new')).toBeNull()
  })

  it('keeps an unsaved new task across returning to the board without creating a record', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.click(screen.getByRole('button', { name: zh['task.new'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.title'] }), { target: { value: 'An unsaved idea' } })
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.new'] }))
    expect(screen.getByRole('textbox', { name: zh['task.title'] })).toHaveProperty('value', 'An unsaved idea')
    fireEvent.click(screen.getByRole('button', { name: zh['task.discard'] }))
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('personal-workbench/task-draft/new')).toBeNull()
  })

  it('edits the task title without replacing its identity or native conversation associations', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.editTitle'] }))
    fireEvent.change(screen.getByRole('textbox', { name: zh['task.title'] }), { target: { value: 'Updated task title' } })
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledTimes(1) })
    expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'update', expectedRevision: 1, itemId: row.item.id, title: 'Updated task title',
    }))
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].taskSession).toBeUndefined()
    expect(await screen.findByRole('heading', { name: 'Updated task title' })).toBeTruthy()
  })

  it('filters native task conversations without opening or changing them', async () => {
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Fixture time')
    const callbacks = api({ ...row, item: { ...row.item, sessions: [{
      id: '00000000-0000-4000-8000-000000000007' as TaskSessionId,
      title: 'Existing conversation', provider: 'dsh', state: 'ready', createdAt: '2026-09-08T00:00:00Z',
    }] } })
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.queryByRole('button', { name: /^Existing conversation/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'DSH' }))
    expect(screen.getByRole('button', { name: /^Existing conversation/ })).toBeTruthy()
    expect(callbacks.openTaskSession).not.toHaveBeenCalled()
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    await expect(Array.from(screen.getByRole('region', { name: zh['task.sessions'] }).querySelectorAll('button')).map(button => button.getAttribute('aria-label') ?? button.textContent)).toMatchFileSnapshot('./expected/task-session-controls.txt')
  })

  it('hides native archives and starts new chats without writing empty associations', async () => {
    const id = '00000000-0000-4000-8000-000000000007' as TaskSessionId
    const callbacks = api({ ...row, item: { ...row.item, sessions: [{
      id, title: 'Existing conversation', provider: 'dsh', state: 'ready', createdAt: '2026-09-08T00:00:00Z',
    }] } })
    const props = { page: 'board' as const, api: callbacks, t, pollIntervalMs: 60_000, sessions, onTaskDetail: () => {} }
    const view = render(<Journal {...props} archivedSessionIds={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: /积压事项 ·/ }))
    fireEvent.doubleClick(await screen.findByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: t('task.archiveSession', { title: 'Existing conversation' }) }))
    await waitFor(() => { expect(callbacks.archiveTaskSession).toHaveBeenCalledWith(expect.objectContaining({ id })) })
    expect(callbacks.openTaskSession).not.toHaveBeenCalled()
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    view.rerender(<Journal {...props} archivedSessionIds={[id as string as NonNullable<SessionListState['current']>]} />)
    expect(screen.queryByText('Existing conversation')).toBeNull()
    expect(screen.getByText(zh['task.noSessions'])).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole('button', { name: zh['task.newSession'] })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: zh['task.newSession'] }))
    await waitFor(() => {
      expect(callbacks.beginTaskSession).toHaveBeenLastCalledWith(row.item.id, row.item.title, expect.any(AbortSignal), true)
    })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('keeps the task conversation visible and retryable when native archiving fails', async () => {
    const callbacks = api({ ...row, item: { ...row.item, sessions: [{
      id: '00000000-0000-4000-8000-000000000007' as TaskSessionId,
      title: 'Keep this conversation', provider: 'dsh', state: 'ready', createdAt: '2026-09-08T00:00:00Z',
    }] } })
    vi.mocked(callbacks.archiveTaskSession).mockRejectedValueOnce(new Error('Archive offline'))
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    const archive = screen.getByRole('button', { name: t('task.archiveSession', { title: 'Keep this conversation' }) })
    fireEvent.click(archive)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Archive offline')
    expect(screen.getByText('Keep this conversation')).toBeTruthy()
    expect(archive).toHaveProperty('disabled', false)
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('starts a task chat without writing an empty association', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.newSession'] }))
    await waitFor(() => {
      expect(callbacks.beginTaskSession).toHaveBeenLastCalledWith(row.item.id, row.item.title, expect.any(AbortSignal), true)
    })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('shows a failed new task conversation and allows retry', async () => {
    const callbacks = api()
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    await waitFor(() => { expect(callbacks.beginTaskSession).toHaveBeenCalledTimes(1) })
    vi.mocked(callbacks.beginTaskSession).mockRejectedValueOnce(new Error('Offline'))
    fireEvent.click(screen.getByRole('button', { name: zh['task.newSession'] }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline')
    fireEvent.click(screen.getByRole('button', { name: zh['task.newSession'] }))
    await waitFor(() => { expect(callbacks.beginTaskSession).toHaveBeenCalledTimes(3) })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('locks further drags until authoritative rows arrive and uses their revision for the next action', async () => {
    const callbacks = api()
    const canonical: JournalRow = {
      ...row,
      revision: 42,
      order: 0,
      item: { ...row.item, status: 'active' },
      execution: { startedAt: '2026-09-07T03:00:00Z', startedOn: '2026-09-07', endedAt: null, endedOn: null },
    }
    const refreshed = { items: [canonical], nextOffset: null, total: 1 }
    const sync = Promise.withResolvers<typeof refreshed>()
    vi.mocked(callbacks.journalQuery)
      .mockResolvedValue(refreshed)
      .mockResolvedValueOnce({ items: [row], nextOffset: null, total: 1 })
      .mockReturnValueOnce(sync.promise)
    await board(callbacks)
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByRole('region', { name: zh['gantt.ongoing'] }),
    )
    await waitFor(() => {
      expect(callbacks.journalQuery).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('article', { name: row.item.title }).draggable).toBe(false)
    sync.resolve(refreshed)
    await waitFor(() => {
      expect(screen.getByRole('article', { name: row.item.title }).draggable).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: zh['gantt.finish'] }))
    await waitFor(() => {
      expect(callbacks.journalWrite).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedRevision: 42, status: 'done' }),
      )
    })
  })

  it('does not resend a saved mutation after refresh failure and unlocks after a successful retry', async () => {
    const callbacks = api()
    await board(callbacks)
    const query = vi.mocked(callbacks.journalQuery)
    const original = query.getMockImplementation()!
    query.mockRejectedValue(new Error('Offline'))
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByRole('region', { name: zh['gantt.ongoing'] }),
    )
    await waitFor(() => {
      expect(screen.getByRole('article', { name: row.item.title }).draggable).toBe(false)
    })
    const retry = await screen.findByRole('button', { name: zh['journal.refresh'] })
    expect(callbacks.journalWrite).toHaveBeenCalledOnce()
    query.mockImplementation(original)
    fireEvent.click(retry)
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull()
    })
    expect(
      within(screen.getByRole('region', { name: zh['gantt.ongoing'] })).getByRole('article').draggable,
    ).toBe(true)
    expect(callbacks.journalWrite).toHaveBeenCalledOnce()
  })

  it('starts backlog work at drop time without creating daily plans or invented hours', async () => {
    const callbacks = api()
    await board(callbacks)
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByRole('region', { name: zh['gantt.ongoing'] }),
    )
    await waitFor(() => {
      expect(within(screen.getByRole('complementary')).queryByRole('article')).toBeNull()
    })
    expect(
      within(screen.getByRole('region', { name: zh['gantt.ongoing'] })).getByRole('article', {
        name: row.item.title,
      }),
    ).toBeTruthy()
    const request = vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0]
    expect(request).toMatchObject({
      operation: 'update',
      expectedRevision: 1,
      status: 'active',
      timeline: null,
    })
    expect(request?.plan).toBeUndefined()
    expect(request?.minutes).toBeUndefined()
    expect(screen.queryByText(zh['journal.actual'])).toBeNull()
  })

  it('preserves the backlog when the start is rejected', async () => {
    const callbacks = api()
    vi.mocked(callbacks.journalWrite).mockRejectedValue(new Error('This item changed'))
    await board(callbacks)
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByRole('region', { name: zh['gantt.ongoing'] }),
    )
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This item changed')
    expect(within(screen.getByRole('complementary')).getByRole('article')).toBeTruthy()
  })

  it('keeps date navigation and instructions behind their toolbar controls', async () => {
    await board(api())
    expect(screen.getByRole('heading', { name: zh['nav.board'] })).toBeTruthy()
    const picker = screen.getByLabelText(zh['planner.chooseWeek'])
    expect(picker.parentElement?.hasAttribute('open')).toBe(false)
    fireEvent.click(picker)
    expect(picker.parentElement?.hasAttribute('open')).toBe(true)
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-10' } })
    expect(picker.parentElement?.hasAttribute('open')).toBe(false)
    expect(screen.getByLabelText(zh['planner.jumpDate'])).toHaveProperty('value', '2026-09-07')
    const help = screen.getByLabelText(zh['planner.help'])
    expect(help.parentElement?.hasAttribute('open')).toBe(false)
    fireEvent.click(help)
    expect(within(help.parentElement!).getByText(zh['gantt.hint'])).toBeTruthy()
  })

  it('keeps task content and keyboard access when moving the same card into execution', async () => {
    const callbacks = api({ ...row, item: { ...row.item, nextAction: 'Inspect update logic' } })
    await board(callbacks)
    const card = screen.getByRole('article', { name: row.item.title })
    const content = (element: HTMLElement) => Array.from(element.querySelectorAll('strong,p'))
      .map(value => value.textContent)
    expect(content(card)).toMatchInlineSnapshot(`
      [
        "Reflection work",
      ]
    `)
    expect(card.querySelector('[data-track]')).toBeNull()
    drag(card, screen.getByRole('region', { name: zh['gantt.ongoing'] }))
    const moved = await within(screen.getByRole('region', { name: zh['gantt.ongoing'] }))
      .findByRole('article', { name: row.item.title })
    expect(content(moved)).toEqual(content(card))
    expect(moved.tabIndex).toBe(0)
    expect(within(moved).queryByText(zh['planner.independent'])).toBeNull()
    expect(moved.querySelector('[data-track]')).not.toBeNull()
    fireEvent.keyDown(moved, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: row.item.title })).toBeTruthy()
  })

  it('keeps execution order despite newer edits, and pool search does not hide active work', async () => {
    const callbacks = api()
    const second = {
      ...row,
      item: {
        ...row.item,
        id: '00000000-0000-4000-8000-000000000003' as JournalId,
        title: 'Second task',
        status: 'active' as const,
      },
      execution: { startedAt: '2026-09-07T03:00:00Z', startedOn: '2026-09-07', endedAt: null, endedOn: null },
    }
    const first = {
      ...row,
      item: { ...row.item, status: 'active' as const },
      execution: { startedAt: '2026-09-07T01:00:00Z', startedOn: '2026-09-07', endedAt: null, endedOn: null },
    }
    vi.mocked(callbacks.journalQuery).mockResolvedValue({
      items: [second, first],
      total: 2,
      nextOffset: null,
    })
    await board(callbacks)
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-07' } })
    fireEvent.change(screen.getByLabelText(zh['journal.search']), { target: { value: 'not found' } })
    expect(
      within(screen.getByRole('region', { name: zh['gantt.ongoing'] }))
        .getAllByRole('article')
        .map(el => el.getAttribute('aria-label')),
    ).toEqual(['Reflection work', 'Second task'])
    fireEvent.click(screen.getAllByRole('button', { name: zh['gantt.finish'] })[0]!)
    await waitFor(() => {
      expect(callbacks.journalWrite).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'done', expectedRevision: 1 }),
      )
    })
  })

  it('opens an in-pane task document on double click without duplicate controls', async () => {
    const callbacks = api()
    await board(callbacks)
    expect(screen.queryByRole('button', { name: zh['planner.newTask'] })).toBeNull()
    expect(screen.getByRole('button', { name: zh['gantt.start'] })).toBeTruthy()
    expect(
      within(screen.getByRole('complementary')).queryByRole('button', { name: zh['planner.details'] }),
    ).toBeNull()
    expect(screen.queryByText(zh['gantt.ongoingHelp'])).toBeNull()
    expect(screen.queryByText(zh['gantt.order'])).toBeNull()
    expect({
      backlogActions: within(screen.getByRole('complementary'))
        .queryAllByRole('button')
        .map(button => button.textContent),
      cards: within(screen.getByRole('complementary'))
        .getAllByRole('article')
        .map(card => card.getAttribute('aria-label')),
    }).toMatchInlineSnapshot(`
      {
        "backlogActions": [
          "×",
          "＋",
          "开始推进",
        ],
        "cards": [
          "Reflection work",
        ],
      }
    `)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: zh['task.details'] })).toBeTruthy()
    expect(screen.getByRole('heading', { name: zh['task.content'] })).toBeTruthy()
    expect(screen.getByRole('region', { name: zh['task.sessions'] })).toBeTruthy()
    expect(callbacks.journalHistory).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    expect(screen.getByRole('complementary')).toBeTruthy()
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })

  it('drags execution work back to backlog and into the trash using revision-checked writes', async () => {
    const callbacks = api({
      ...row,
      item: { ...row.item, status: 'active' },
      execution: {
        startedAt: '2026-09-07T00:00:00Z',
        startedOn: '2026-09-07',
        endedAt: null,
        endedOn: null,
      },
    })
    await board(callbacks)
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-07' } })
    drag(screen.getByRole('article', { name: row.item.title }), screen.getByRole('complementary'))
    await waitFor(() => {
      expect(callbacks.journalWrite).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'todo', timeline: null, expectedRevision: 1 }),
      )
    })
    await waitFor(() => {
      expect(within(screen.getByRole('complementary')).getByRole('article')).toBeTruthy()
    })
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByRole('region', { name: zh['gantt.ongoing'] }),
    )
    await waitFor(() => {
      expect(within(screen.getByRole('complementary')).queryByRole('article')).toBeNull()
    })
    drag(
      screen.getByRole('article', { name: row.item.title }),
      screen.getByTitle(zh['gantt.trashHelp']),
    )
    await waitFor(() => {
      expect(callbacks.journalWrite).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'delete', expectedRevision: 3 }),
      )
    })
  })

  it.each(['todo', 'active'] as const)('deletes a %s task through the shared drop region exactly once', async (status) => {
    const callbacks = api({ ...row, item: { ...row.item, status } })
    await board(callbacks)
    const trash = screen.getByTitle(zh['gantt.trashHelp'])
    expect(trash.hidden).toBe(true)
    const card = screen.getByRole('article', { name: row.item.title })
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(card, { dataTransfer })
    expect(trash.hidden).toBe(false)
    fireEvent.dragOver(trash, { dataTransfer })
    expect(trash.getAttribute('data-over')).toBe('true')
    expect(dataTransfer.dropEffect).toBe('move')
    const leave = new Event('dragleave', { bubbles: true })
    Object.defineProperty(leave, 'relatedTarget', { value: trash.querySelector('span') })
    fireEvent(trash, leave)
    expect(trash.getAttribute('data-over')).toBe('true')
    fireEvent.drop(trash, { dataTransfer })
    fireEvent.drop(trash, { dataTransfer })
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalledTimes(1) })
    expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({
      itemId: row.item.id, expectedRevision: 1, operation: 'delete',
    }))
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].status).toBeUndefined()
    expect(trash.getAttribute('data-over')).toBe('false')
    expect(trash.hidden).toBe(true)
    expect(await screen.findByRole('button', { name: zh['journal.undo'] })).toBeTruthy()
  })

  it('does not delete tasks for external or canceled drags', async () => {
    const callbacks = api()
    await board(callbacks)
    const trash = screen.getByTitle(zh['gantt.trashHelp'])
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.drop(trash, { dataTransfer })
    fireEvent.dragStart(screen.getByRole('article', { name: row.item.title }), { dataTransfer })
    expect(trash.hidden).toBe(false)
    fireEvent.dragOver(trash, { dataTransfer })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.drop(trash, { dataTransfer })
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
    expect(trash.getAttribute('data-dragging')).toBe('false')
    expect(trash.hidden).toBe(true)
    const card = screen.getByRole('article', { name: row.item.title })
    fireEvent.dragStart(card, { dataTransfer })
    expect(trash.hidden).toBe(false)
    fireEvent.dragEnd(card, { dataTransfer })
    expect(trash.hidden).toBe(true)
  })

  it('reorders between execution rows without accidentally restarting the dragged task', async () => {
    const callbacks = api()
    const first = {
      ...row,
      order: 0,
      item: { ...row.item, status: 'active' as const },
      execution: { startedAt: '2026-09-07T00:00:00Z', startedOn: '2026-09-07', endedAt: null, endedOn: null },
    }
    const second = {
      ...first,
      order: 1,
      item: { ...first.item, id: '00000000-0000-4000-8000-000000000009' as JournalId, title: 'Second' },
    }
    vi.mocked(callbacks.journalQuery).mockResolvedValue({
      items: [first, second],
      total: 2,
      nextOffset: null,
    })
    await board(callbacks)
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-07' } })
    drag(
      screen.getByRole('article', { name: 'Second' }),
      screen.getByRole('article', { name: row.item.title }),
    )
    await waitFor(() => {
      expect(callbacks.journalWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'reorder',
          itemId: second.item.id,
          reorderBefore: first.item.id,
        }),
      )
    })
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].status).toBeUndefined()
    expect(callbacks.journalWrite).toHaveBeenCalledTimes(1)
  })

  it('uses shared week navigation and pane actions in reflection', async () => {
    const callbacks = api()
    const toggle = vi.fn()
    render(<Journal page="reflection" api={callbacks} t={t} pollIntervalMs={60_000}
      archivedSessionIds={[]} sessions={sessions} onTaskDetail={() => {}}
      boardActions={<button onClick={toggle}>DSH</button>} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh['nav.reflection'])
    fireEvent.change(screen.getByLabelText(zh['planner.jumpDate']), { target: { value: '2026-09-10' } })
    await waitFor(() => { expect(callbacks.journalReport).toHaveBeenLastCalledWith('2026-09-07') })
    fireEvent.click(screen.getByLabelText(zh['journal.nextWeek']))
    await waitFor(() => { expect(callbacks.journalReport).toHaveBeenLastCalledWith('2026-09-14') })
    fireEvent.click(screen.getByRole('button', { name: 'DSH' }))
    expect(toggle).toHaveBeenCalledOnce()
    expect(callbacks.assist).not.toHaveBeenCalled()
  })

  it('requests a native DSH reflection without faking a generated report', async () => {
    const callbacks = api()
    render(
      <Journal
        page="reflection"
        api={callbacks}
        t={t}
        pollIntervalMs={60_000}
        archivedSessionIds={[]}
        sessions={sessions}
        onTaskDetail={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: zh['journal.generate'] }))
    await waitFor(() => {
      expect(callbacks.assist).toHaveBeenCalledWith(expect.stringContaining('journal_save_reflection'))
    })
    expect(callbacks.journalSaveReport).not.toHaveBeenCalled()
  })
})


describe('compact backlog drawer', () => {
  it('starts closed, opens without navigation and begins work from its shortcut', async () => {
    const callbacks = api()
    await board(callbacks, false)
    expect(screen.queryByRole('article', { name: row.item.title })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /积压事项 ·/ }))
    expect(screen.getByRole('article', { name: row.item.title })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['gantt.start'] }))
    await waitFor(() =>{  expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' })) })
    expect(screen.getByRole('button', { name: /积压事项 ·/ }).getAttribute('aria-expanded')).toBe('true')
  })
  it('keeps ended tasks out of current work until selected', async () => {
    await board(api({ ...row, item: { ...row.item, status: 'done' } }), false)
    expect(screen.queryByRole('article')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /本周已结束 ·/ }))
    expect(screen.getByRole('article', { name: row.item.title })).toBeTruthy()
  })
  it('locks drawer geometry while dragging and retains the selected insertion target', async () => {
    const callbacks = api()
    const current = { ...row, item: { ...row.item, id: '00000000-0000-4000-8000-000000000003' as JournalId, title: 'Existing work', status: 'active' as const } }
    vi.mocked(callbacks.journalQuery).mockResolvedValue({ items: [row, current], total: 2, nextOffset: null })
    await board(callbacks)
    const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(screen.getByRole('article', { name: row.item.title }), { dataTransfer: transfer })
    expect((screen.getByRole('button', { name: zh['planner.closeBacklog'] })).disabled).toBe(true)
    fireEvent.drop(screen.getByRole('article', { name: 'Existing work' }), { dataTransfer: transfer, clientY: 0 })
    await waitFor(() =>{  expect(callbacks.journalWrite).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', reorderBefore: current.item.id })) })
  })
})


describe('task screenshots', () => {
  it.each(['personal-image:v1:fixture', `personal-image:v2:${'a'.repeat(64)}.png`])('pastes, previews, saves and reopens %s', async (destination) => {
    const callbacks = api()
    vi.mocked(callbacks.journalUploadImage).mockResolvedValue(destination)
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    const input = screen.getByRole('textbox', { name: zh['task.brief'] }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'before\nafter' } })
    input.setSelectionRange(7, 7)
    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['image'], 'screen.png', { type: 'image/png' }) }] } })
    await waitFor(() => { expect(input.value).toContain(`![截图](${destination.includes(':v1:') ? 'task-image-1' : destination})`) })
    expect(input.value.indexOf('![截图]')).toBeLessThan(input.value.indexOf('after'))
    expect(callbacks.journalUploadImage).toHaveBeenCalledWith('aW1hZ2U=', 'image/png')
    expect(screen.queryByRole('img', { name: '截图' })).toBeNull()
    if (destination.includes(':v1:')) expect(input.value).not.toContain('personal-image:')
    input.setSelectionRange(0, input.value.length)
    const copy = { setData: vi.fn() }
    fireEvent.copy(input, { clipboardData: copy })
    expect(copy.setData).toHaveBeenCalledWith('text/plain', expect.stringContaining(destination))
    fireEvent.click(screen.getByRole('button', { name: zh['task.preview'], exact: true }))
    expect(screen.queryByRole('textbox', { name: zh['task.brief'] })).toBeNull()
    await waitFor(() => { expect(screen.getByRole('img', { name: '截图' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('checkbox', { name: zh['task.autoPolish'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['journal.save'] }))
    await waitFor(() => { expect(callbacks.journalWrite).toHaveBeenCalled() })
    expect(vi.mocked(callbacks.journalWrite).mock.calls[0]?.[0].description).toContain(destination)
    fireEvent.click(screen.getByRole('button', { name: zh['task.back'] }))
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    await waitFor(() => { expect(screen.getByRole('img', { name: '截图' })).toBeTruthy() })
  })

  it('keeps the draft when an image upload fails', async () => {
    const callbacks = api()
    vi.mocked(callbacks.journalUploadImage).mockRejectedValue(new Error('upload failed'))
    await board(callbacks)
    fireEvent.doubleClick(screen.getByRole('article', { name: row.item.title }))
    fireEvent.click(screen.getByRole('button', { name: zh['task.edit'] }))
    const input = screen.getByRole('textbox', { name: zh['task.brief'] }) as HTMLTextAreaElement
    const original = input.value
    fireEvent.paste(input, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['image'], 'screen.png', { type: 'image/png' }) }] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('upload failed') })
    expect(input.value).toBe(original)
    expect(callbacks.journalWrite).not.toHaveBeenCalled()
  })
})
