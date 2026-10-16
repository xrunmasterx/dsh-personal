// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JournalPage, JournalId } from '@xrunmasterx/dsh-personal-host/client'
import { useJournalBoard } from '../src/client/use-journal-board.ts'

const page: JournalPage = {
  items: [
    {
      item: {
        id: '00000000-0000-4000-8000-000000000001' as JournalId,
        title: 'Work',
        status: 'todo',
        plans: [],
        links: [],
        nextAction: '',
        createdOn: '2026-09-07',
      },
      revision: 1,
      eventId: '00000000-0000-4000-8000-000000000002' as JournalId,
    },
  ],
  total: 1,
  nextOffset: null,
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('journal board read lifecycle', () => {
  it('reuses unchanged rows, suspends hidden polling, resumes once and stops after unmount', async () => {
    vi.useFakeTimers()
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const api = { journalQuery: vi.fn(async () => structuredClone(page)) }
    const view = renderHook(() => useJournalBoard(api, 1000))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const original = view.result.current.rows
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(view.result.current.rows).toBe(original)
    expect(api.journalQuery).toHaveBeenCalledTimes(2)
    hidden = true
    await act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(api.journalQuery).toHaveBeenCalledTimes(2)
    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(api.journalQuery).toHaveBeenCalledTimes(3)
    view.unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.journalQuery).toHaveBeenCalledTimes(3)
  })

  it('stops superseded pagination and never replaces committed rows with an older response', async () => {
    vi.useFakeTimers()
    const old = Promise.withResolvers<JournalPage>()
    const latest = { ...page, items: page.items.map(row => ({ ...row, revision: 2 })) }
    const api = {
      journalQuery: vi
        .fn(async () => latest)
        .mockResolvedValueOnce(page)
        .mockReturnValueOnce(old.promise),
    }
    const view = renderHook(() => useJournalBoard(api, 1000))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(api.journalQuery).toHaveBeenCalledTimes(2)
    await act(async () => {
      await view.result.current.run(async () => {
        view.result.current.changed()
      })
    })
    expect(view.result.current.rows[0]?.revision).toBe(2)
    await act(async () => {
      old.resolve({ ...page, total: 2, nextOffset: 1 })
    })
    expect(api.journalQuery).toHaveBeenCalledTimes(3)
    expect(view.result.current.rows[0]?.revision).toBe(2)
    expect(view.result.current.busy).toBe(false)
  })

  it('does not request later pages after the view is disposed', async () => {
    const pending = Promise.withResolvers<JournalPage>()
    const api = { journalQuery: vi.fn(() => pending.promise) }
    const view = renderHook(() => useJournalBoard(api, 1000))
    view.unmount()
    await act(async () => {
      pending.resolve({ ...page, total: 2, nextOffset: 1 })
    })
    expect(api.journalQuery).toHaveBeenCalledOnce()
  })
})
