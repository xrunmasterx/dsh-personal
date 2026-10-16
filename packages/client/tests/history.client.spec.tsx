// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HistoryCard, HistorySettings as Preferences, HistoryMessageId, HistoryId } from '@xrunmasterx/dsh-personal-host/client'
import { History, HistoryReadingHost, type HistoryActions } from '../src/client/History.tsx'
import { HistorySettings } from '../src/client/HistorySettings.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = ((key: keyof typeof zh, args?: Record<string, unknown>) => Object.entries(args ?? {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), zh[key])) as Parameters<typeof History>[0]['t']
const taskId = '00000000-0000-4000-8000-000000000001'
const id = 'a'.repeat(64) as HistoryId
const messageId = 'evidence-1' as HistoryMessageId
const card: HistoryCard = {
  id, source: 'cursor', sourceId: 'original-id', location: '/cursor', title: 'IBL discussion', cwd: '/project',
  available: true, revision: 1, analysis: { summary: 'General summary', unclassified: false,
    matches: [{ taskId, summary: 'Task-specific summary', evidence: [messageId] }] },
  analyzedAt: '2026-09-09T08:00:00Z', model: 'fixture/model', locked: false, ignored: false, taskIds: [taskId],
  error: null, failures: 0, retryAt: 0, manualSummaryPending: false,
  firstAt: '2026-09-09T07:00:00Z', lastAt: '2026-09-09T08:00:00Z', pending: false, messageCount: 2,
}
function actions(): HistoryActions {
  return {
    list: vi.fn(async () => ({ items: [card], total: 1, pendingCount: 0, failedCount: 0, nextOffset: null,
      running: false, lastScan: null, nextScan: null, sources: [], error: null })),
    read: vi.fn(async (_id, offset) => ({ messages: [{ id: offset ? messageId : 'first' as HistoryMessageId,
      at: card.firstAt, role: 'user' as const, text: offset ? 'Verification evidence' : 'Question', hash: 'hash', truncated: false }], nextOffset: offset ? null : 1 })),
    sync: vi.fn(async () => {}), rule: vi.fn(async () => {}),
    tasks: vi.fn(async () => ({ items: [], nextOffset: null, total: 0, revision: 0 } as Awaited<ReturnType<HistoryActions['tasks']>>)),
  }
}

it('emphasizes questions and answers while collapsing progress and revealing cited progress', async () => {
  const api = actions()
  api.read = vi.fn<HistoryActions['read']>(async () => ({ messages: [
    { id: 'question' as HistoryMessageId, at: card.firstAt, role: 'user', text: 'Please configure the app', hash: 'q', truncated: false },
    { id: messageId, at: card.firstAt, role: 'assistant', phase: 'progress', text: 'Checking the directory', hash: 'p', truncated: false },
    { id: 'answer' as HistoryMessageId, at: card.lastAt, role: 'assistant', phase: 'answer', text: '## Result\nReady to use', hash: 'a', truncated: false },
  ], nextOffset: null }))
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  await screen.findByRole('heading', { name: 'Result' })
  const disclosure = screen.getByText('查看过程消息 · 1 条').closest('details')!
  expect(disclosure.open).toBe(false)
  expect(screen.getByText('Checking the directory').closest('details')).toBe(disclosure)
  expect(screen.getByRole('article', { name: '你的提问' })).toBeTruthy()
  expect(screen.getByRole('article', { name: '助手回答' })).toBeTruthy()
  expect([screen.getByText('你的提问').textContent, screen.getByText('查看过程消息 · 1 条').textContent,
    screen.getByText('助手回答').textContent]).toMatchSnapshot()
  fireEvent.click(screen.getByText('依据 1'))
  await waitFor(() => { expect(disclosure.open).toBe(true) })
  expect(document.activeElement).toBe(screen.getByText('Checking the directory').closest('article'))
})

it('shows task-specific summaries and loads cited messages beyond the first page', async () => {
  const api = actions()
  render(<History api={api} t={t} taskId={taskId} />)
  expect(await screen.findByText('Task-specific summary')).toBeTruthy()
  expect(screen.queryByText('General summary')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: card.title }))
  await screen.findByText('Question')
  fireEvent.click(screen.getByText('依据 1'))
  expect(await screen.findByText('Verification evidence')).toBeTruthy()
  expect(api.read).toHaveBeenCalledWith(id, 1)
  expect(api.sync).not.toHaveBeenCalled()
  expect(api.rule).not.toHaveBeenCalled()
})

it.each([null, taskId])('deletes and restores a conversation without opening it in view %s', async (filter) => {
  const api = actions()
  let current = card
  api.list = vi.fn(async (_task, mode) => ({ items: current.ignored === (mode === 'ignored') ? [current] : [],
    total: current.ignored === (mode === 'ignored') ? 1 : 0, pendingCount: 0, failedCount: 0, nextOffset: null,
    running: false, lastScan: null, nextScan: null, sources: [], error: null }))
  api.rule = vi.fn<HistoryActions['rule']>(async (request) => { current = { ...current, ignored: request.ignored, revision: current.revision + 1 } })
  render(<History api={api} t={t} taskId={filter} />)
  fireEvent.click(await screen.findByRole('button', { name: '删除会话' }))
  await waitFor(() =>{  expect(api.rule).toHaveBeenCalledWith({ id, revision: 1, taskIds: [taskId], ignored: true }) })
  expect(await screen.findByText('已删除「IBL discussion」，可在回收站恢复。')).toBeTruthy()
  expect(screen.queryByRole('button', { name: card.title })).toBeNull()
  expect(api.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  await screen.findByRole('button', { name: card.title })
  expect(api.rule).toHaveBeenLastCalledWith({ id, revision: 2, taskIds: [taskId], ignored: false })
})

it('opens the summary itself and retains the card after deletion fails', async () => {
  const api = actions()
  api.rule = vi.fn(async () => { throw new Error('Save failed') })
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: '删除会话' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: card.title })).toBeTruthy()
  expect(api.read).not.toHaveBeenCalled()
  expect(screen.queryByText('查看记录')).toBeNull()
  expect(screen.queryByText('忽略会话')).toBeNull()
  fireEvent.click(screen.getByText('General summary'))
  await screen.findByText('Question')
})

it('keeps the transcript open when task assignment is cancelled', async () => {
  const api = actions()
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  await screen.findByText('Question')
  fireEvent.click(screen.getByText('调整归属'))
  fireEvent.click(await screen.findByText('取消'))
  expect(screen.getByText('Question')).toBeTruthy()
  expect(screen.getByText('返回列表')).toBeTruthy()
  expect(screen.queryByText('保存归属')).toBeNull()
  expect(api.rule).not.toHaveBeenCalled()
})

it('does not steal keyboard focus when the archive rerenders after following a citation', async () => {
  const api = actions()
  const view = render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  await screen.findByText('Question')
  fireEvent.click(screen.getByText('依据 1'))
  await screen.findByText('Verification evidence')
  const back = screen.getByText('返回列表')
  back.focus()
  view.rerender(<History api={api} t={t} pollIntervalMs={7000} />)
  expect(document.activeElement).toBe(back)
})

it('searches through the host and keeps filters after viewing a result', async () => {
  const api = actions()
  render(<History api={api} t={t} />)
  fireEvent.change(screen.getByLabelText('搜索标题、摘要或会话 ID'), { target: { value: 'normalization' } })
  fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'cursor' } })
  await waitFor(() => { expect(api.list).toHaveBeenCalledWith(null, 'inbox', 0, 'normalization', 'cursor') })
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  await screen.findByText('Question')
  fireEvent.click(screen.getByText('返回列表'))
  expect(screen.getByLabelText<HTMLInputElement>('搜索标题、摘要或会话 ID').value).toBe('normalization')
  expect(screen.getByLabelText<HTMLSelectElement>('来源').value).toBe('cursor')
  expect(screen.getByText<HTMLButtonElement>('重试失败项').disabled).toBe(true)
})

it('returns to the actual previous page instead of the first page', async () => {
  const api = actions()
  api.list = vi.fn(async (_task: string | null, _mode: 'inbox' | 'all' | 'ignored', offset: number) => ({ items: [{ ...card, title: `Page ${offset}` }], total: 3,
    pendingCount: 0, failedCount: 0, nextOffset: offset < 2 ? offset + 1 : null,
    running: false, lastScan: null, nextScan: null, sources: [], error: null }))
  render(<History api={api} t={t} />)
  await screen.findByText('Page 0')
  fireEvent.click(screen.getByText('下一页'))
  await screen.findByText('Page 1')
  fireEvent.click(screen.getByText('下一页'))
  await screen.findByText('Page 2')
  fireEvent.click(screen.getByText('上一页'))
  expect(await screen.findByText('Page 1')).toBeTruthy()
})

it('renders readable answers and focuses the cited question', async () => {
  const api = actions()
  api.read = vi.fn(async () => ({ messages: [
    { id: 'answer' as HistoryMessageId, at: card.firstAt, role: 'assistant' as const, text: '## Verified result', hash: 'a', truncated: false },
    { id: messageId, at: card.lastAt, role: 'user' as const, text: 'Original question', hash: 'b', truncated: false },
  ], nextOffset: null }))
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  expect(await screen.findByRole('heading', { name: 'Verified result' })).toBeTruthy()
  const question = screen.getByText('Original question').closest('article')
  fireEvent.click(screen.getByText('依据 1'))
  await waitFor(() => { expect(document.activeElement).toBe(question) })
})

it('saves interval and model independently through native settings', async () => {
  const value: Preferences = { enabled: true, codex: true, cursor: true, intervalMinutes: 60, lookback: 'week', model: { provider: 'a', model: 'one' } }
  const state: SettingsScopeSnapshot<Preferences> = { status: 'ready', value, base: {}, user: {}, revision: 0, writable: true, mode: 'host' }
  const set = vi.fn(async (key: string, next: unknown) => { Object.assign(value, { [key]: next }) })
  const scope: SettingsScope<Preferences> = { getSnapshot: () => state, subscribe: () => () => {}, set, unset: vi.fn(), mutate: vi.fn() }
  render(<HistorySettings scope={scope} load={async () => [{ provider: 'b', model: 'two', label: 'Second model' }]} t={t} />)
  expect((screen.getByLabelText<HTMLSelectElement>('扫描周期')).value).toBe('60')
  fireEvent.change(screen.getByLabelText('扫描周期'), { target: { value: '15' } })
  await waitFor(() =>{  expect(set).toHaveBeenCalledWith('intervalMinutes', 15) })
  await screen.findByText('Second model')
  fireEvent.change(screen.getByLabelText('分析模型'), { target: { value: '0' } })
  await waitFor(() =>{  expect(set).toHaveBeenCalledWith('model', { provider: 'b', model: 'two' }) })
  expect(value.lookback).toBe('week')
})

it('applies task source filters before pagination and leaves the count to its parent', async () => {
  const api = actions()
  render(<History api={api} t={t} taskId={taskId} taskSource="cursor" />)
  await screen.findByText('Task-specific summary')
  expect(api.list).toHaveBeenCalledWith(taskId, 'inbox', 0, '', 'cursor')
  expect(screen.queryByText('共 1 个会话')).toBeNull()
})

it('groups archive controls and keeps record metadata behind disclosure', async () => {
  const api = actions()
  render(<History api={api} t={t} />)
  await screen.findByText('General summary')
  await expect(screen.getByRole('group', { name: '归档视图' }).textContent).toMatchFileSnapshot('./expected/archive-view-controls.txt')
  expect(screen.getByText('同步详情').closest('details')?.open).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: card.title }))
  await screen.findByText('Question')
  expect(screen.getByText('记录信息').closest('details')?.open).toBe(false)
  expect(screen.getByRole('heading', { name: '相关摘要' })).toBeTruthy()
  expect(screen.getByText('General summary')).toBeTruthy()
})

it('shows initial coverage without presenting an unfinished summary and still opens the questions', async () => {
  const api = actions()
  api.list = vi.fn(async () => ({ items: [{ ...card, analysis: null, pending: true, fullHistory: true,
    initialComplete: false, progress: { completed: 1, total: 3 } }], total: 1, pendingCount: 1, failedCount: 0,
  nextOffset: null, running: true, lastScan: null, nextScan: null, sources: [], error: null }))
  render(<History api={api} t={t} />)
  expect(await screen.findByText('首次分析中 · 已处理 1/3 条')).toBeTruthy()
  expect(screen.queryByText('General summary')).toBeNull()
  expect(screen.getByText('首次分析中 · 已处理 1/3 条').textContent).toMatchSnapshot()
  fireEvent.click(screen.getByRole('button', { name: card.title }))
  expect(await screen.findByText('Question')).toBeTruthy()
})

it('updates initial progress while reading without reloading the transcript', async () => {
  const api = actions()
  let current: HistoryCard = { ...card, analysis: null, pending: true, fullHistory: true,
    initialComplete: false, progress: { completed: 1, total: 3 } }
  api.list = vi.fn(async () => ({ items: [current], total: 1, pendingCount: current.pending ? 1 : 0, failedCount: 0,
    nextOffset: null, running: current.pending, lastScan: null, nextScan: null, sources: [], error: null }))
  render(<History api={api} t={t} pollIntervalMs={30} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  await screen.findByText('Question')
  current = { ...card, fullHistory: true, initialComplete: true }
  expect(await screen.findByText('General summary')).toBeTruthy()
  expect(screen.queryByText('首次分析中 · 已处理 1/3 条')).toBeNull()
  expect(api.read).toHaveBeenCalledTimes(1)
})

it('removes only a leading request wrapper from questions without changing stored text', async () => {
  const api = actions()
  const original = '## My request:\r\n\r\n重启可视化面板\n\n保留 **全部问答**'
  const messages = [
    { id: messageId, at: card.firstAt, role: 'user' as const, text: original, hash: 'q', truncated: false },
    { id: 'a' as HistoryMessageId, at: card.lastAt, role: 'assistant' as const, text: '## My request:\nAssistant content', hash: 'a', truncated: false },
    { id: 'b' as HistoryMessageId, at: card.lastAt, role: 'user' as const, text: 'Quoted heading\n\n## My request:\nKeep this section', hash: 'b', truncated: false },
  ]
  api.read = vi.fn(async () => ({ messages, nextOffset: null }))
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  const question = (await screen.findByText('重启可视化面板')).closest('article')!
  expect(question.textContent).not.toContain('My request:')
  expect(screen.getByText('全部问答').tagName).toBe('STRONG')
  expect(screen.getAllByRole('heading', { name: 'My request:' })).toHaveLength(2)
  expect(messages[0]?.text).toBe(original)
  expect(question.textContent).toMatchSnapshot()
})

it('opens task histories in the work-area host and restores the retained card on Escape', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  try {
    render(<HistoryReadingHost.Provider value={host}><History api={actions()} t={t} taskId={taskId} /></HistoryReadingHost.Provider>)
    const opener = await screen.findByRole('button', { name: card.title })
    fireEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: card.title })
    await screen.findByText('Question')
    expect(host.contains(dialog)).toBe(true)
    expect(document.activeElement).toBe(dialog)
    expect(opener.isConnected).toBe(true)
    expect(dialog.querySelector('h3')?.textContent).toMatchSnapshot()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(document.activeElement).toBe(opener)
    expect(host.childElementCount).toBe(0)
  } finally { host.remove() }
})

it('renders structured summaries as headings and lists in the reading view', async () => {
  const api = actions()
  api.list = vi.fn(async () => ({ items: [{ ...card, analysis: { ...card.analysis!, summary: '核心结论。\n\n#### 主要进展\n- **阅读界面**：已更新。\n\n#### 验证情况\n- Agent 报告：测试通过。' } }], total: 1, pendingCount: 0, failedCount: 0, nextOffset: null, running: false, lastScan: null, nextScan: null, sources: [], error: null }))
  render(<History api={api} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: card.title }))
  expect(await screen.findByRole('heading', { name: '主要进展' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '验证情况' })).toBeTruthy()
  expect(screen.getByText('Agent 报告：测试通过。').closest('li')).toBeTruthy()
})
