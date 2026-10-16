// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ReviewWeek, ReviewId, ReviewSourceId, ReviewActivity } from '@xrunmasterx/dsh-personal-host/client'
import { Retrospective, type ReviewActions } from '../src/client/Retrospective.tsx'
import { zh } from '../src/client/locales.ts'
import { localDay, monday, shift } from '../src/client/journal-calendar.ts'

const t = ((key: keyof typeof zh, params: Record<string, string | number> = {}) =>
  zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))) as ComponentProps<typeof Retrospective>['t']
afterEach(() => { cleanup(); sessionStorage.clear() })
function fixture() {
  const day = localDay(), from = monday(day)
  const activity: ReviewActivity = { id: 'activity' as ReviewId, day, title: 'Investigated reflection', markdown: 'Agent reported a fix.\n\nRuntime validation remains pending.',
    tags: ['debug' as const], taskIds: [], evidence: ['message' as ReviewSourceId] }
  const week: ReviewWeek = { from, today: day, timeZone: 'Asia/Shanghai', running: false, sourceErrors: [], tasks: [],
    weekly: null, weeklyStale: false, corrections: [],
    sources: [{ id: 'message' as ReviewSourceId, day, at: `${day}T10:00:00Z`, kind: 'codex', role: 'assistant', label: 'Source conversation' }],
    days: Array.from({ length: 7 }, (_, i) => ({ day: shift(from, i), activities: shift(from, i) === day ? [activity] : [],
      updatedAt: null, error: null, stale: false })) }
  const api: ReviewActions = { read: vi.fn(async () => week), sync: vi.fn(async () => {}), edit: vi.fn(async () => {}),
    source: vi.fn(async () => ({ id: 'message' as ReviewSourceId, day, at: `${day}T10:00:00Z`, kind: 'codex', role: 'assistant', label: 'Source conversation', text: 'Original answer', taskIds: [] })) }
  const legacy = vi.fn((_week: string) => <p>Retained weekly reports</p>)
  const mount = () => render(<Retrospective api={api} t={t} pollIntervalMs={60000} legacy={legacy} />)
  return { day, activity, week, api, mount, legacy }
}
it('opens daily evidence without invoking a model and retains the old report entry', async () => {
  const h = fixture(); h.mount()
  fireEvent.click(await screen.findByRole('button', { name: /Investigated reflection/ }))
  expect(screen.getByText('Runtime validation remains pending.')).toBeTruthy()
  expect(h.api.sync).not.toHaveBeenCalled()
  expect(h.api.source).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '查看依据 · 1' }))
  expect(await screen.findByText('Original answer')).toBeTruthy()
  expect(h.api.source).toHaveBeenCalledWith('message')
  fireEvent.click(screen.getByRole('button', { name: zh['review.legacy'] }))
  expect(screen.getByText('Retained weekly reports')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '上一周' }))
  expect(h.legacy).toHaveBeenLastCalledWith(shift(h.week.from, -7))
})
it('preserves an unsaved correction after failure and sends its displayed revision', async () => {
  const h = fixture(); vi.mocked(h.api.edit).mockRejectedValueOnce(new Error('revision conflict')); h.mount()
  fireEvent.click(await screen.findByRole('button', { name: zh['review.edit'] }))
  fireEvent.change(screen.getByLabelText(zh['review.content']), { target: { value: 'User confirmed yesterday.' } })
  fireEvent.click(screen.getByRole('button', { name: zh['review.save'] }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: revision conflict')
  expect(screen.getByLabelText(zh['review.content'])).toHaveProperty('value', 'User confirmed yesterday.')
  fireEvent.click(screen.getByRole('button', { name: zh['review.save'] }))
  await waitFor(() => { expect(screen.queryByLabelText(zh['review.content'])).toBeNull() })
  expect(vi.mocked(h.api.edit).mock.calls[0]?.[0].activity.markdown).toBe('User confirmed yesterday.')
  expect(vi.mocked(h.api.edit).mock.calls[0]?.[0].expectedRevision).toBe(0)
})
it('distinguishes empty days, source errors and stale weekly synthesis', async () => {
  const h = fixture(); h.week.sourceErrors = ['Cursor archive unavailable']; h.week.weeklyStale = true; h.mount()
  await screen.findByText('Cursor archive unavailable')
  const other = h.week.days.find(d => d.day !== h.day)!
  fireEvent.click(screen.getByRole('button', { name: new RegExp(other.day.slice(5)) }))
  expect(screen.getByText(zh[other.day > h.day ? 'review.future' : 'review.empty'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['review.week'] }))
  expect(screen.getByText(zh['review.staleWeek'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['review.update'] }))
  await waitFor(() => { expect(h.api.sync).toHaveBeenCalledWith(other.day) })
})

it('keeps a correction attached to its card while changing dates and restores its draft after navigation and reload', async () => {
  const h = fixture(); const page = h.mount()
  fireEvent.click(await screen.findByRole('button', { name: zh['review.edit'] }))
  const card = screen.getByRole('article', { name: h.activity.title })
  expect(within(card).getByRole('form', { name: zh['review.editor'] })).toBeTruthy()
  fireEvent.change(screen.getByLabelText(zh['review.date']), { target: { value: shift(h.day, -1) } })
  fireEvent.change(screen.getByLabelText(zh['review.content']), { target: { value: 'Actually validated yesterday.' } })
  expect(within(card).getByLabelText(zh['review.content'])).toHaveProperty('value', 'Actually validated yesterday.')
  fireEvent.click(screen.getByRole('button', { name: zh['review.week'] }))
  expect(screen.queryByRole('form')).toBeNull()
  expect(screen.getByRole('button', { name: zh['review.continueDraft'] })).toBeTruthy()
  page.unmount(); h.mount()
  fireEvent.click(await screen.findByRole('button', { name: zh['review.continueDraft'] }))
  expect(screen.getByLabelText(zh['review.content'])).toHaveProperty('value', 'Actually validated yesterday.')
  fireEvent.click(screen.getByRole('button', { name: zh['review.save'] }))
  await waitFor(() => { expect(screen.queryByRole('form')).toBeNull() })
  expect(vi.mocked(h.api.edit).mock.calls[0]?.[0].activity).toMatchObject({ day: shift(h.day, -1), markdown: 'Actually validated yesterday.' })
})

it('adds a note without requiring a separate title and retains multiple task associations', async () => {
  const h = fixture()
  h.week.tasks = [{ id: 'task1' as ReviewWeek['tasks'][number]['id'], title: 'First task' }, { id: 'task2' as ReviewWeek['tasks'][number]['id'], title: 'Second task' }]
  h.mount()
  await screen.findByRole('article')
  fireEvent.click(screen.getByRole('button', { name: zh['review.add'] }))
  fireEvent.change(screen.getByLabelText(zh['review.content']), { target: { value: 'Validated the reflection fix.\nNext step: mobile.' } })
  fireEvent.click(screen.getByText(zh['review.associations']))
  fireEvent.change(screen.getByLabelText(zh['review.task']), { target: { value: 'task1' } })
  fireEvent.change(screen.getByLabelText(zh['review.task']), { target: { value: 'task2' } })
  fireEvent.click(screen.getByLabelText(zh['review.learning']))
  fireEvent.click(screen.getByRole('button', { name: zh['review.save'] }))
  await waitFor(() => { expect(h.api.edit).toHaveBeenCalled() })
  expect(vi.mocked(h.api.edit).mock.calls[0]?.[0].activity).toMatchObject({ title: 'Validated the reflection fix.', taskIds: ['task1', 'task2'], tags: ['learning'] })
})

it('retains full Markdown and restores filters and expansion after returning to the review', async () => {
  const h = fixture(); h.activity.markdown = `${'Text '.repeat(55)}\`VeryLongFunctionName\`.\n\nSupporting details.`
  const page = h.mount()
  expect((await screen.findByText('VeryLongFunctionName')).tagName).toBe('CODE')
  fireEvent.click(screen.getByRole('button', { name: /Investigated reflection/ }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'reflection' } })
  fireEvent.change(screen.getByLabelText(zh['review.category']), { target: { value: 'debug' } })
  page.unmount(); h.mount()
  expect(await screen.findByText('Supporting details.')).toBeTruthy()
  expect(screen.getByRole('searchbox')).toHaveProperty('value', 'reflection')
  expect(screen.getByLabelText(zh['review.category'])).toHaveProperty('value', 'debug')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'absent' } })
  expect(screen.getByText(zh['review.noMatches'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['review.clearFilters'] }))
  expect(screen.getByRole('article')).toBeTruthy()
})

it('offers an immediate revision-checked undo after hiding a card', async () => {
  const h = fixture(); h.mount()
  fireEvent.click(await screen.findByRole('button', { name: zh['review.hide'] }))
  fireEvent.click(await screen.findByRole('button', { name: zh['review.undo'] }))
  await screen.findByText(zh['review.restored'])
  expect(vi.mocked(h.api.edit).mock.calls.map(([request]) => ({ hidden: request.hidden, revision: request.expectedRevision })))
    .toEqual([{ hidden: true, revision: 0 }, { hidden: false, revision: 1 }])
})

it('retries a failed evidence read without loading the rest of the sources', async () => {
  const h = fixture(); vi.mocked(h.api.source).mockRejectedValueOnce(new Error('Source temporarily unavailable')); h.mount()
  fireEvent.click(await screen.findByRole('button', { name: '查看依据 · 1' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Source temporarily unavailable'))
  fireEvent.click(screen.getByRole('button', { name: zh['review.retry'] }))
  expect(await screen.findByText('Original answer')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(h.api.source).toHaveBeenCalledTimes(2)
})

it('queues an update while another week is running and distinguishes first-generation failure from an empty day', async () => {
  const h = fixture(); h.week.running = true
  const current = h.week.days.find(d => d.day === h.day)!
  current.activities = []; current.error = 'Model timed out'; h.mount()
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '本次整理失败：Model timed out')
  expect(screen.getByText(zh['review.noPublished'])).toBeTruthy()
  expect(screen.queryByText(zh['review.empty'])).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh['review.update'] }))
  expect(await screen.findByText(zh['review.queued'])).toBeTruthy()
  expect(h.api.sync).toHaveBeenCalledWith(h.day)
})

it('shows the context of a historical journal entry without hiding its original receipt', async () => {
  const h = fixture()
  h.week.sources[0] = { ...h.week.sources[0]!, kind: 'journal', role: 'recorded-user-change' }
  vi.mocked(h.api.source).mockResolvedValue({ ...h.week.sources[0], taskIds: [], text: JSON.stringify({
    operation: 'update', reason: 'Reviewing last week', progress: 'Implemented **screenshots** last week.', statusChange: { from: 'todo', to: 'active' },
  }) })
  h.mount()
  fireEvent.click(await screen.findByRole('button', { name: '查看依据 · 1' }))
  expect(await screen.findByText(/Reviewing last week/, { selector: 'p' })).toBeTruthy()
  expect(screen.getByText('screenshots').tagName).toBe('STRONG')
  expect(screen.getByText(/待开始 → 推进中/)).toBeTruthy()
  fireEvent.click(screen.getByText(zh['review.rawRecord']))
  expect(screen.getByText(/"operation": "update"/)).toBeTruthy()
})

it('loads one selected message when a card cites several messages', async () => {
  const h = fixture()
  h.activity.evidence.push('second' as ReviewSourceId)
  h.week.sources.push({ ...h.week.sources[0]!, id: 'second' as ReviewSourceId, role: 'user' })
  h.mount()
  fireEvent.click(await screen.findByRole('button', { name: '查看依据 · 2' }))
  expect(screen.getByText('Source conversation')).toBeTruthy()
  expect(h.api.source).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(/助手回答 ·/))
  expect(await screen.findByText('Original answer')).toBeTruthy()
  expect(h.api.source).toHaveBeenCalledExactlyOnceWith('message')
})

it('keeps long task associations out of the preview while exposing every task on expansion', async () => {
  const h = fixture()
  h.week.tasks = Array.from({ length: 4 }, (_, i) => ({ id: `task${i}` as ReviewWeek['tasks'][number]['id'], title: `Related task ${i}` }))
  h.activity.taskIds = h.week.tasks.map(task => task.id)
  h.mount()
  expect(await screen.findByText('+2 个相关任务')).toBeTruthy()
  expect(screen.queryByText('Related task 3')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Investigated reflection/ }))
  expect(screen.getByText('Related task 3')).toBeTruthy()
})

it('does not imply that a future date is generating while the background worker is busy', async () => {
  const h = fixture(); h.week.running = true; h.week.today = h.week.from
  h.week.days.forEach((day) => { day.activities = [] }); h.mount()
  const future = shift(h.week.from, 1)
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(future) }))
  expect(screen.getByText(zh['review.future'])).toBeTruthy()
  expect(screen.getByRole('button', { name: zh['review.add'] })).toHaveProperty('disabled', true)
})
