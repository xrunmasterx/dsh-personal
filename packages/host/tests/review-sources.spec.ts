import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { reviewInputs, reviewHash } from '../src/review-sources.ts'
import { historyRecordSchema, type HistoryPage } from '../src/history-schema.ts'
import { codeRecordSchema, type CodePage } from '../src/code-schema.ts'
import { WorkJournal, type JournalId } from '../src/journal.ts'
import { harness } from './helpers.ts'

it('uses message occurrence dates across paged sessions and preserves immutable versions of source text', async () => {
  const h = await harness(); const journal = await WorkJournal.open(h.ctx, 1, 1048576)
  try {
    const record = historyRecordSchema.parse({ id: 'a'.repeat(64), source: 'codex', sourceId: 'session', location: '', title: 'Long debugging conversation', cwd: '',
      available: true, revision: 1, messages: [
        { id: 'old', at: '2026-09-27T15:59:00Z', role: 'user', text: 'Earlier topic', hash: 'old', truncated: false },
        { id: 'today', at: '2026-09-27T16:01:00Z', role: 'assistant', text: 'New finding', hash: 'new', truncated: false },
        { id: 'later', at: '2026-09-28T16:01:00Z', role: 'user', text: 'Next day topic', hash: 'later', truncated: false },
      ], analyzed: {}, fullHistory: true, analysis: null, analyzedAt: null, model: '', locked: false, ignored: false,
      taskIds: [], error: null, failures: 0, retryAt: 0 })
    const page: HistoryPage = {
      items: [{ ...record, firstAt: record.messages[0]!.at, lastAt: record.messages[2]!.at, pending: false, messageCount: 3 }], total: 1,
      pendingCount: 0, failedCount: 0, nextOffset: null, running: false, lastScan: '2026-09-29T00:00:00Z', nextScan: null, sources: [], error: null }
    const history = { list: () => page,
      read: (_id: unknown, offset: number) => ({ messages: record.messages.slice(offset, offset + 1),
        nextOffset: offset < 2 ? offset + 1 : null }) }
    const code: { list: () => CodePage } = { list: () => ({
      items: [], nextOffset: null, total: 0, running: false, lastScan: null, error: null }) }
    const inputs = reviewInputs(history, code, journal, '2026-09-28', '2026-09-28', 'Asia/Shanghai')
    expect(inputs.sources.map(s => s.text)).toEqual(['New finding'])
    expect(inputs.errors).toEqual([])
    record.messages[1]!.text = 'Corrected finding'
    const changed = reviewInputs(history, code, journal, '2026-09-28', '2026-09-28', 'Asia/Shanghai')
    expect(changed.sources[0]!.id).not.toBe(inputs.sources[0]!.id)
    page.sources.push({ source: 'cursor', path: '', error: 'unavailable' })
    expect(reviewInputs(history, code, journal, '2026-09-28', '2026-09-28', 'Asia/Shanghai').errors).toContain('cursor: unavailable')
  } finally { await journal.close(); await h.close() }
})

it('does not backdate a newly observed branch stage to commit time or infer daily activity from an active task', async () => {
  const h = await harness(); const journal = await WorkJournal.open(h.ctx, 1, 1048576)
  try {
    await journal.write({ requestId: randomUUID() as JournalId, itemId: randomUUID() as JournalId,
      operation: 'create', expectedRevision: 0, day: '2026-09-20', title: 'Still active', status: 'active', reason: 'User started work' })
    await journal.write({ requestId: randomUUID() as JournalId, itemId: randomUUID() as JournalId,
      operation: 'create', expectedRevision: 0, day: '2026-09-28', title: 'Imported history', text: 'Implemented screenshots last week', reason: 'Review of last week’s conversations' })
    const commit = codeRecordSchema.parse({ id: 'commit', project: 'project', sha: 'a'.repeat(40), title: 'Reflection fix', message: 'Fix',
      author: 'user', committedAt: '2026-09-20T00:00:00Z', discoveredAt: '2026-09-28T00:00:00Z', url: 'https://git.example.test/commit/a',
      branches: ['main'], stage: 'main', stageEvents: [{ stage: 'main', observedAt: '2026-09-28T01:00:00Z' }], sourceSha: null, patchHash: null,
      equivalentTo: null, diff: null, diffExpired: false, chunks: [], analysis: null, analyzedAt: null, error: null, attempts: 0 })
    const history = { list: (): HistoryPage => ({ items: [], total: 0, pendingCount: 0, failedCount: 0, nextOffset: null, running: false,
      lastScan: '2026-09-28T00:00:00Z', nextScan: null, sources: [], error: null }), read: () => ({ messages: [], nextOffset: null }) }
    const code = { list: (): CodePage => ({
      items: [{ ...commit, commits: [commit] }], total: 1, nextOffset: null, running: false, lastScan: null, error: null }) }
    const sources = reviewInputs(history, code, journal, '2026-09-28', '2026-09-28', 'Asia/Shanghai').sources
    expect(sources).toHaveLength(2)
    const observation = sources.find(s => s.kind === 'code')!
    expect(observation).toMatchObject({ day: '2026-09-28', role: 'branch-observation' })
    expect(JSON.parse(observation.text)).toMatchObject({ event: 'stage-observed', stage: 'main' })
    expect(JSON.parse(sources.find(s => s.kind === 'journal')!.text)).toMatchObject({ reason: 'Review of last week’s conversations', progress: 'Implemented screenshots last week' })
    expect(reviewHash({ a: 1, b: 2 })).toBe(reviewHash({ b: 2, a: 1 }))
  } finally { await journal.close(); await h.close() }
})
