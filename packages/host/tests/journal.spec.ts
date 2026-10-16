import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkJournal, type JournalId, type JournalWrite, type TaskSessionId } from '../src/journal.ts'
import { harness } from './helpers.ts'

const uuid = () => randomUUID() as JournalId
const create = (title: string): JournalWrite => ({
  requestId: uuid(),
  itemId: uuid(),
  operation: 'create',
  expectedRevision: 0,
  day: '2026-09-07',
  title,
  reason: 'Explicit user instruction',
})

describe('personal work journal', () => {
  it('retains manual follow-today intent across restart and undo without changing execution dates', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const request = create('Manual progress')
      await journal.write({ ...request, status: 'active' })
      const read = () => journal.query({ from: null, to: null, text: '', includeOpen: true, offset: 0 }).items[0]!
      const change = (patch: Partial<JournalWrite>) => journal.write({ ...request, requestId: uuid(), operation: 'update', expectedRevision: read().revision, ...patch })
      const execution = read().execution
      await change({ timeline: { from: '2026-09-07', to: '2026-09-09', followToday: true } })
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(read().item.timeline?.followToday).toBe(true)
      await change({ timeline: { from: '2026-09-07', to: '2026-09-08', followToday: false } })
      expect(read().item.timeline?.followToday).toBe(false)
      await change({ operation: 'undo' })
      expect(read().item.timeline?.followToday).toBe(true)
      expect(read().execution).toEqual(execution)
    } finally { await journal.close(); await h.close() }
  })

  it('stores card summaries with their source and invalidates them on document or state changes', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const request = create('Summary lifecycle')
      await journal.write({ ...request, description: '## 进展\n已观察：完成读取', summary: '完成读取' })
      const read = () => journal.query({ from: null, to: null, text: '', includeOpen: true, offset: 0 }).items[0]!
      const change = (patch: Partial<JournalWrite>) => journal.write({ ...request, requestId: uuid(), operation: 'update', expectedRevision: read().revision, ...patch })
      await change({ title: 'Renamed task' })
      expect(read().item.summary).toBe('完成读取')
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(read().item.summary).toBe('完成读取')
      await expect(change({ summary: 'No source' })).rejects.toThrow('with its description')
      await change({ status: 'active' })
      expect(read().item.summary).toBeUndefined()
      await change({ operation: 'undo' })
      expect(read().item.summary).toBe('完成读取')
      await change({ description: '## 进展\n待验证：检查输出' })
      expect(read().item.summary).toBeUndefined()
      await change({ description: '## 进展\n待验证：检查输出', summary: '' })
      expect(read().item.summary).toBe('')
    } finally { await journal.close(); await h.close() }
  })

  it('persists task documents and session reservations without changing work state', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const request = create('Task with native conversations')
      await journal.write({ ...request, status: 'active', description: '## What\n\nInvestigate reflections' })
      const read = () =>
        journal.query({ from: null, to: null, text: '', includeOpen: true, offset: 0 }).items[0]!
      const change = (patch: Partial<JournalWrite>) =>
        journal.write({
          ...request,
          requestId: uuid(),
          operation: 'update',
          expectedRevision: read().revision,
          ...patch,
        })
      const session = { id: randomUUID() as TaskSessionId, title: 'Investigation', state: 'pending' as const }
      await expect(change({ taskSession: { ...session, state: 'ready' } })).rejects.toThrow('Reserve')
      const reserved = await change({ taskSession: session })
      await change({ taskSession: session })
      expect(read().item.sessions).toHaveLength(1)
      await change({ taskSession: { ...session, state: 'ready' } })
      await expect(change({ taskSession: session })).rejects.toThrow('conflicts')
      await expect(
        change({ taskSession: { ...session, title: 'Another title', state: 'ready' } }),
      ).rejects.toThrow('conflicts')
      await change({ description: '## Why\n\nStable rendering' })
      expect(read().item).toMatchObject({
        status: 'active',
        description: '## Why\n\nStable rendering',
        sessions: [{ ...session, state: 'ready', createdAt: reserved.after?.sessions?.[0]?.createdAt }],
      })
      await expect(
        journal.write({
          ...request,
          requestId: uuid(),
          operation: 'update',
          expectedRevision: 1,
          description: 'Stale text',
        }),
      ).rejects.toThrow('changed')
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(read().item.sessions?.[0]?.state).toBe('ready')
      expect(read().item.description).toBe('## Why\n\nStable rendering')
      await change({ operation: 'undo' })
      expect(read().item.description).toBe('## What\n\nInvestigate reflections')
      expect(read().item.sessions?.[0]?.state).toBe('ready')
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('appends restarted work, reorders it, and restores order through deletion, undo and reopening', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const first = create('First')
      const second = create('Second')
      const rows = () => journal.query({ from: null, to: null, text: '', includeOpen: true, offset: 0 }).items
      const order = () =>
        rows()
          .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
          .filter(row => row.item.status !== 'todo')
          .map(row => row.item.title)
      const change = (itemId: JournalId, update: Partial<JournalWrite>) =>
        journal.write({
          itemId,
          requestId: uuid(),
          expectedRevision: rows().find(row => row.item.id === itemId)!.revision,
          operation: 'update',
          day: '2026-09-08',
          reason: 'Explicit drag',
          ...update,
        })
      await journal.write({ ...first, status: 'active' })
      await journal.write({ ...second, status: 'active' })
      expect(order()).toEqual(['First', 'Second'])
      await change(first.itemId, { status: 'todo', timeline: null })
      expect(order()).toEqual(['Second'])
      await change(first.itemId, { status: 'active', timeline: null })
      expect(order()).toEqual(['Second', 'First'])
      expect(rows().find(row => row.item.id === first.itemId)?.execution?.startedOn).toBe('2026-09-08')
      const sorted = await change(first.itemId, { operation: 'reorder', reorderBefore: second.itemId })
      expect(order()).toEqual(['First', 'Second'])
      await expect(
        journal.write({
          ...first,
          requestId: uuid(),
          operation: 'reorder',
          expectedRevision: 1,
          reorderBefore: null,
        }),
      ).rejects.toThrow('changed')
      expect(order()).toEqual(['First', 'Second'])
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(order()).toEqual(['First', 'Second'])
      const removed = await change(first.itemId, { operation: 'delete' })
      expect(order()).toEqual(['Second'])
      await journal.write({
        itemId: first.itemId,
        requestId: uuid(),
        expectedRevision: removed.revision,
        operation: 'undo',
        day: '2026-09-08',
        reason: 'Restore task',
      })
      expect(order()).toEqual(['First', 'Second'])
      expect(journal.readEvent(sorted.id).ordering?.items).toEqual([first.itemId, second.itemId])
      await change(first.itemId, { operation: 'reorder', reorderBefore: null })
      await change(second.itemId, { operation: 'reorder', reorderBefore: null })
      await expect(change(first.itemId, { operation: 'undo' })).rejects.toThrow('Board order changed')
      expect(order()).toEqual(['First', 'Second'])
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('retains unlinked work, original plans and backfilled progress through moves, undo and reopening', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
    try {
      const request = create('Reflection investigation')
      const original = await journal.write({
        ...request,
        plan: { day: '2026-09-07', intention: 'Reproduce', start: null, end: null },
      })
      const moved = await journal.write({
        requestId: uuid(),
        itemId: request.itemId,
        expectedRevision: 1,
        operation: 'plan',
        day: '2026-09-07',
        replaceDay: '2026-09-07',
        plan: { day: '2026-09-09', intention: 'Reproduce', start: null, end: null },
        reason: 'Urgent work arrived',
      })
      expect(moved.after?.plans.map(p => p.day)).toEqual(['2026-09-09'])
      expect(moved.before?.plans[0]?.day).toBe('2026-09-07')
      expect(journal.activity('2026-09-09', '2026-09-09', 0).events.map(value => value.id)).toContain(
        moved.id,
      )
      const progress = await journal.write({
        requestId: uuid(),
        itemId: request.itemId,
        expectedRevision: 2,
        operation: 'progress',
        day: '2026-09-06',
        text: 'Found the cause; fix unverified',
        status: 'active',
        reason: 'Backfilled yesterday',
      })
      expect(progress.log?.minutes).toBeNull()
      expect(journal.activity('2026-09-06', '2026-09-06', 0).events[0]?.id).toBe(progress.id)
      expect(journal.history(request.itemId, 2).events[0]?.id).toBe(original.id)
      const undo = await journal.write({
        requestId: uuid(),
        itemId: request.itemId,
        expectedRevision: 3,
        operation: 'undo',
        day: '2026-09-07',
        reason: 'Correction',
      })
      expect(undo.after).toEqual(moved.after)
      expect(journal.activity('2026-09-06', '2026-09-06', 0).revertedIds).toEqual([progress.id])
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
      expect(
        journal.query({ from: null, to: null, includeOpen: true, offset: 0, text: '' }).items[0]?.revision,
      ).toBe(4)
      expect(journal.readEvent(original.id)).toEqual(original)
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('reconstructs execution dates, keeps range overrides separate, and restores dates through undo and reopening', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const request = create('Gantt work')
      await journal.write(request)
      const change = (expectedRevision: number, patch: Partial<JournalWrite>) =>
        journal.write({
          requestId: uuid(),
          itemId: request.itemId,
          expectedRevision,
          operation: 'update',
          day: '2026-09-08',
          reason: 'Explicit',
          ...patch,
        })
      const started = await change(1, { status: 'active' })
      await change(2, { day: '2026-09-09', status: 'blocked' })
      const completed = await change(3, { day: '2026-09-11', status: 'done' })
      await change(4, { timeline: { from: '2026-09-07', to: '2026-09-12' } })
      const read = () =>
        journal.query({ from: null, to: null, includeOpen: true, text: '', offset: 0 }).items[0]!
      expect(read().execution).toEqual({
        startedAt: started.at,
        startedOn: '2026-09-08',
        endedAt: completed.at,
        endedOn: '2026-09-11',
      })
      expect(read().item.timeline).toEqual({ from: '2026-09-07', to: '2026-09-12' })
      await expect(change(5, { timeline: { from: '2026-09-12', to: '2026-09-07' } })).rejects.toThrow(
        'ordered',
      )
      await change(5, { operation: 'undo' })
      expect(read().item.timeline).toBeUndefined()
      expect(read().execution?.endedOn).toBe('2026-09-11')
      await change(6, { status: 'active' })
      expect(read().execution?.endedOn).toBeNull()
      expect(
        journal.query({ from: '2026-09-14', to: '2026-09-20', includeOpen: false, text: '', offset: 0 })
          .total,
      ).toBe(1)
      await change(7, { operation: 'undo' })
      expect(read().execution?.endedOn).toBe('2026-09-11')
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(read().execution?.startedAt).toBe(started.at)
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('persists reordering, preserves execution through delete undo, and returns work to backlog', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      const first = create('First')
      const second = create('Second')
      await journal.write({ ...first, status: 'active' })
      await journal.write({ ...second, status: 'active' })
      const change = (request: JournalWrite, revision: number, patch: Partial<JournalWrite>) =>
        journal.write({
          ...request,
          requestId: uuid(),
          expectedRevision: revision,
          operation: 'update',
          ...patch,
        })
      const ordered = () =>
        journal
          .query({ from: null, to: null, includeOpen: true, text: '', offset: 0 })
          .items.filter(row => row.item.status !== 'todo')
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      const execution = ordered().find(row => row.item.id === second.itemId)?.execution
      const moved = await change(second, 1, { operation: 'reorder', reorderBefore: first.itemId })
      expect(ordered().map(row => row.item.id)).toEqual([second.itemId, first.itemId])
      expect(moved.before?.status).toBe(moved.after?.status)
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
      expect(ordered().map(row => row.item.id)).toEqual([second.itemId, first.itemId])
      await change(second, 2, { operation: 'delete' })
      expect(ordered().map(row => row.item.id)).toEqual([first.itemId])
      await change(second, 3, { operation: 'undo' })
      expect(ordered()[0]?.item.id).toBe(second.itemId)
      expect(ordered()[0]?.execution).toEqual(execution)
      await change(second, 4, { status: 'todo', timeline: null })
      expect(ordered().map(row => row.item.id)).toEqual([first.itemId])
      await expect(change(first, 1, { operation: 'reorder', reorderBefore: second.itemId })).rejects.toThrow(
        'target item changed',
      )
      const again = await change(first, 1, { operation: 'reorder', reorderBefore: null })
      expect(again.ordering?.version).toBeGreaterThan(moved.ordering?.version ?? 0)
      await change(first, 2, { operation: 'undo' })
      expect(ordered()[0]?.item.id).toBe(first.itemId)
      await expect(change(second, 3, { operation: 'delete' })).rejects.toThrow('changed')
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('serializes edits, rejects stale undo and detects conflicting retry identities', async () => {
    const h = await harness()
    const journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
    try {
      const request = create('Unplanned debugging')
      const first = await journal.write(request)
      expect(await journal.write(request)).toEqual(first)
      await expect(journal.write({ ...request, title: 'Different' })).rejects.toThrow('identity')
      const change: JournalWrite = {
        requestId: uuid(),
        itemId: request.itemId,
        expectedRevision: 1,
        operation: 'update',
        day: '2026-09-07',
        status: 'done',
        reason: 'User confirmed done',
      }
      const results = await Promise.allSettled([
        journal.write(change),
        journal.write({ ...change, requestId: uuid() }),
      ])
      expect(results.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
      await expect(journal.write({ ...change, operation: 'undo', requestId: uuid() })).rejects.toThrow(
        'changed',
      )
      await expect(
        journal.write({
          ...change,
          requestId: uuid(),
          expectedRevision: 2,
          operation: 'plan',
          plan: { day: '2026-09-07', intention: '', start: '14:00', end: '13:00' },
        }),
      ).rejects.toThrow()
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('paginates items and dated activity independently and retains undo evidence for removed items', async () => {
    const h = await harness()
    const journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
    try {
      const requests = [create('A'), create('B'), create('C')]
      for (const request of requests) await journal.write(request)
      expect(journal.query({ from: null, to: null, includeOpen: true, offset: 0, text: '' }).nextOffset).toBe(
        2,
      )
      expect(journal.activity('2026-09-07', '2026-09-07', 0).nextOffset).toBe(2)
      await journal.write({ ...requests[0]!, requestId: uuid(), operation: 'undo', expectedRevision: 1 })
      expect(journal.query({ from: null, to: null, includeOpen: true, offset: 0, text: '' }).total).toBe(2)
      const receipts = [
        journal.activity('2026-09-07', '2026-09-07', 0),
        journal.activity('2026-09-07', '2026-09-07', 2),
      ]
      expect(receipts.flatMap(value => value.revertedIds)).toContain(requests[0]!.requestId)
    } finally {
      await journal.close()
      await h.close()
    }
  })

  it('saves cited retrospective versions and detects stale evidence, concurrent edits and invalid references', async () => {
    const h = await harness()
    let journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
    try {
      const request = create('Temporary crash debugging')
      const receipt = await journal.write({ ...request, text: 'Cause identified; testing remains' })
      const week = journal.week('2026-09-13', 0)
      expect([week.from, week.to]).toEqual(['2026-09-07', '2026-09-13'])
      const save = {
        kind: 'generate' as const,
        id: uuid(),
        from: week.from,
        fingerprint: week.fingerprint,
        references: [receipt.id],
        markdown: 'Cause identified. Testing remains.',
        expectedReportId: null,
      }
      const first = await journal.saveReport(save)
      await expect(journal.saveReport({ ...save, id: uuid() })).rejects.toThrow('edited')
      await expect(
        journal.saveReport({ ...save, id: uuid(), expectedReportId: first.id, references: [uuid()] }),
      ).rejects.toThrow('Unknown')
      const edited = await journal.saveReport({
        ...save,
        id: uuid(),
        expectedReportId: first.id,
        markdown: 'Personal correction',
      })
      expect(edited.version).toBe(2)
      await journal.close()
      journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
      expect(journal.report(week.from).report?.markdown).toBe('Personal correction')
      await journal.write({
        requestId: uuid(),
        itemId: request.itemId,
        expectedRevision: 1,
        operation: 'progress',
        day: '2026-09-08',
        text: 'Verified fix',
        status: 'done',
        reason: 'User update',
      })
      expect(journal.report(week.from).stale).toBe(true)
      const manual = await journal.saveReport({
        ...save,
        kind: 'edit',
        id: uuid(),
        expectedReportId: edited.id,
        markdown: 'My own reflection after the source update',
      })
      expect(journal.report(week.from)).toEqual({ report: manual, stale: true })
      await expect(
        journal.saveReport({
          ...save,
          kind: 'edit',
          id: uuid(),
          expectedReportId: manual.id,
          references: [uuid()],
        }),
      ).rejects.toThrow('retain')
      await expect(journal.saveReport({ ...save, id: uuid(), expectedReportId: manual.id })).rejects.toThrow(
        'changed',
      )
      expect(journal.readEvent(receipt.id).log?.text).toBe('Cause identified; testing remains')
    } finally {
      await journal.close()
      await h.close()
    }
  })
})


it('starts backlog work at the drop target atomically and rejects a stale target', async () => {
  const h = await harness()
  const journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
  try {
    const first = create('Active')
    const backlog = create('Backlog')
    await journal.write({ ...first, status: 'active' })
    await journal.write(backlog)
    const start = { ...backlog, requestId: uuid(), operation: 'update' as const, expectedRevision: 1, status: 'active' as const, reorderBefore: uuid() }
    await expect(journal.write(start)).rejects.toThrow('target item changed')
    expect(journal.readItem(backlog.itemId).item.status).toBe('todo')
    const receipt = await journal.write({ ...start, requestId: uuid(), reorderBefore: first.itemId })
    expect(receipt.after?.status).toBe('active')
    expect(receipt.ordering?.items).toEqual([backlog.itemId, first.itemId])
    await journal.write({ ...backlog, requestId: uuid(), operation: 'undo', expectedRevision: 2 })
    expect(journal.readItem(backlog.itemId).item.status).toBe('todo')
  } finally {
    await journal.close()
    await h.close()
  }
})
