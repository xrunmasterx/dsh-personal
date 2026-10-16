import { afterEach, describe, expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Reviews } from '../src/reviews.ts'
import { REVIEW_PROMPT, analyzeReview } from '../src/review-analysis.ts'
import { ReviewPolicySchema, reviewActivitySchema, reviewIdSchema, reviewSourceIdSchema, type ReviewActivity, type ReviewSource } from '../src/review-schema.ts'
import { reviewDay, reviewMonday, type ReviewInputs } from '../src/review-sources.ts'
import { harness } from './helpers.ts'

interface Input {
  kind: 'day' | 'week'
  day: string
  batch?: { source: ReviewSource }[]
  candidates?: ReviewActivity[]
  daily?: ReviewActivity[]
  previous?: ReviewActivity[]
}
class Adapter extends LlmAdapter {
  calls: Input[] = []
  failAt = 0
  foreign = false
  fragment = false
  output = ''
  activityId = ''
  outputDay = ''
  preserveCandidates = false
  onCall?: () => void
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('Expected serialized review input')
    const input = JSON.parse(block.text) as Input
    this.calls.push(input); this.onCall?.()
    if (this.failAt === this.calls.length) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'offline', code: 'unknown' } } }; return }
    const activities: ReviewActivity[] = input.batch
      ? [{ id: reviewIdSchema.parse('new:1'), day: input.day, title: 'Investigated reflection', markdown: 'Agent reported a fix; runtime verification remains pending.',
        tags: ['debug'], taskIds: [], evidence: input.batch.map(e => e.source.id) }]
      : input.kind === 'week' ? (input.daily ?? []).map((a, i) => ({ ...a, id: reviewIdSchema.parse(`new:week${i}`), day: input.day }))
        : this.preserveCandidates ? input.candidates!
          : [{ ...input.candidates![0]!, id: input.previous?.[0]?.id ?? input.candidates![0]!.id,
            evidence: [...new Set(input.candidates!.flatMap(a => a.evidence))] }]
    if (this.foreign) activities[0]!.evidence = [reviewSourceIdSchema.parse('foreign')]
    if (this.output) activities[0]!.markdown = this.output
    if (this.activityId) activities[0]!.id = reviewIdSchema.parse(this.activityId)
    if (this.outputDay && activities[0]) activities[0].day = this.outputDay
    const text = JSON.stringify({ activities })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    const size = this.fragment ? 1 : text.length
    for (let offset = 0; offset < text.length; offset += size) yield { type: 'text-delta', index: 0, text: text.slice(offset, offset + size) }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function source(id: string, day = '2026-09-28', text = 'Diagnosed reflections. Not verified.'): ReviewSource {
  return { id: reviewSourceIdSchema.parse(id), day, at: `${day}T10:00:00Z`, kind: 'codex', label: 'Reflection debugging',
    role: 'assistant/answer', text, taskIds: [] }
}
async function setup(sources = [source('s1')]) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-29T09:00:00Z'))
  const h = await harness(); await h.ctx.plugin(LlmRuntime)
  h.config.review = ReviewPolicySchema({ enabled: false, chunkChars: 1000, maxInputChars: 8000 })
  const adapter = new Adapter(); const off = h.ctx.llm.registerAdapter(['fixture'], adapter)
  const state: ReviewInputs = { sources, errors: [], tasks: [] }
  let owner = await Reviews.open(h.ctx, h.config, () => structuredClone(state))
  return { h, adapter, state, get owner() { return owner },
    async reopen() { await owner.close(); owner = await Reviews.open(h.ctx, h.config, () => structuredClone(state)) },
    async close() { await owner.close(); off(); await h.close() } }
}
afterEach(() => { vi.useRealTimers() })
describe('calendar retrospectives', () => {
  it('rejects an unrequested past date instead of silently publishing it into another daily report', async () => {
    const h = await setup()
    try {
      h.adapter.outputDay = '2026-09-21'
      await h.owner.sync()
      expect(h.owner.read('2026-09-28').days[0]?.error).toContain('source day')
      expect(h.owner.read('2026-09-21').days.flatMap(d => d.activities)).toEqual([])
    } finally { await h.close() }
  })
  it('only revisits recent days automatically and backfills older days on explicit request', async () => {
    const h = await setup([source('old', '2026-09-01'), source('recent')])
    try {
      await h.owner.sync('2026-09-01')
      expect(h.owner.read('2026-09-01').days.flatMap(d => d.activities)).toHaveLength(1)
      const calls = h.adapter.calls.length
      h.state.sources[0] = source('old-revised', '2026-09-01')
      await h.owner.sync()
      expect(h.adapter.calls).toHaveLength(calls)
      await h.owner.sync('2026-09-01')
      expect(h.adapter.calls.length).toBeGreaterThan(calls)
      expect(h.owner.read('2026-09-01').sources.some(s => s.id === 'old-revised')).toBe(true)
    } finally { await h.close() }
  })
  it('fills the first recent week from Monday before publishing its weekly overview', async () => {
    const h = await setup([source('monday', '2026-09-21'), source('tuesday', '2026-09-22'), source('recent')])
    try {
      await h.owner.sync()
      const week = h.owner.read('2026-09-21')
      expect(week.days.every(day => day.updatedAt !== null)).toBe(true)
      expect(week.days.flatMap(day => day.activities)).toHaveLength(2)
      expect(week.weekly?.activities.flatMap(activity => activity.evidence)).toEqual(['monday', 'tuesday'])
      expect(week.weeklyStale).toBe(false)
    } finally { await h.close() }
  })
  it('clears the previous week after moving a manual note twice across old weeks', async () => {
    const h = await setup([])
    try {
      const id = reviewIdSchema.parse('old-manual')
      const activity: ReviewActivity = { id, day: '2026-09-01', title: 'Incident', markdown: 'Crash investigation', tags: ['debug'], taskIds: [], evidence: [] }
      await h.owner.edit({ id, expectedRevision: 0, activity, hidden: false }); await h.owner.sync()
      for (const next of ['2026-09-08', '2026-09-15']) {
        const prior = h.owner.read(activity.day).corrections[0]!
        const previousDay = activity.day; activity.day = next
        await h.owner.edit({ ...prior, expectedRevision: prior.revision, activity: { ...prior.activity, day: next } }); await h.owner.sync()
        expect(h.owner.read(previousDay).weekly?.activities).toEqual([])
        expect(h.owner.read(next).weekly?.activities).toHaveLength(1)
      }
    } finally { await h.close() }
  })
  it('publishes daily and weekly evidence once, survives restart, and never generates on read', async () => {
    const h = await setup()
    try {
      expect(h.owner.read('2026-09-28').days[0]?.activities).toEqual([])
      expect(h.adapter.calls).toHaveLength(0)
      await h.owner.sync()
      const week = h.owner.read('2026-09-28')
      expect(week.sourceErrors).toEqual([])
      expect(week.days[0]?.activities).toHaveLength(1)
      expect(week.weekly?.activities).toHaveLength(1)
      expect(week.weeklyStale).toBe(false)
      expect(h.owner.source(week.days[0]!.activities[0]!.evidence[0]!)).toEqual(source('s1'))
      const calls = h.adapter.calls.length
      await h.reopen(); await h.owner.sync()
      expect(h.adapter.calls).toHaveLength(calls)
      expect(h.owner.read('2026-09-28').days[0]?.activities).toEqual(week.days[0]?.activities)
    } finally { await h.close() }
  })
  it('retains the last complete publication and completed chunks when a replacement fails', async () => {
    const h = await setup()
    try {
      await h.owner.sync()
      const previous = h.owner.read('2026-09-28').days[0]!.activities
      h.state.sources.push(source('s2', '2026-09-28', 'x'.repeat(6500)))
      h.adapter.failAt = h.adapter.calls.length + 2
      await h.owner.sync()
      const failed = h.owner.read('2026-09-28')
      expect(failed.days[0]?.error).toContain('offline')
      expect(failed.days[0]?.activities).toEqual(previous)
      expect(failed.weeklyStale).toBe(true)
      const firstChunk = h.adapter.calls.at(-2)
      h.adapter.failAt = 0
      await h.reopen(); await h.owner.sync('2026-09-28')
      expect(h.owner.read('2026-09-28').days[0]?.error).toBeNull()
      expect(h.adapter.calls.filter(c => JSON.stringify(c) === JSON.stringify(firstChunk))).toHaveLength(1)
      const parts = h.adapter.calls.filter(c => c.batch).flatMap(c => c.batch!).filter(e => e.source.text.startsWith('x'))
      expect(parts.some(e => e.source.text.length === 500)).toBe(true)
    } finally { await h.close() }
  })
  it('keeps corrected dates and contents through regeneration, rejects stale editors and restores hidden cards', async () => {
    const h = await setup()
    try {
      await h.owner.sync()
      const auto = h.owner.read('2026-09-28').days[0]!.activities[0]!
      const corrected = { ...auto, day: '2026-09-29', markdown: 'User confirmed the date and result.' }
      await h.owner.edit({ id: auto.id, expectedRevision: 0, activity: corrected, hidden: false })
      await h.owner.sync()
      h.state.sources.push(source('s2'))
      await h.owner.sync()
      const read = h.owner.read('2026-09-28')
      expect(read.days[0]?.activities).toEqual([])
      expect(read.days[1]?.activities[0]?.markdown).toBe(corrected.markdown)
      await expect(h.owner.edit({ id: auto.id, expectedRevision: 0, activity: auto, hidden: false })).rejects.toThrow('edited elsewhere')
      const c = read.corrections[0]!
      await h.owner.edit({ ...c, expectedRevision: c.revision, hidden: true }); await h.owner.sync()
      expect(h.owner.read('2026-09-29').days[1]?.activities).toEqual([])
      await h.reopen(); await h.owner.sync()
      const hidden = h.owner.read('2026-09-29').corrections[0]!
      expect(hidden.hidden).toBe(true)
      await h.owner.edit({ ...hidden, expectedRevision: hidden.revision, hidden: false }); await h.owner.sync()
      expect(h.owner.read('2026-09-29').days[1]?.activities[0]?.markdown).toBe(corrected.markdown)
    } finally { await h.close() }
  })
  it('retains manual-only days with their own evidence and recomputes both weeks after moving a note', async () => {
    const h = await setup([])
    try {
      await h.owner.sync()
      const id = reviewIdSchema.parse('manual')
      const activity: ReviewActivity = { id, day: '2026-09-28', title: 'Incident', markdown: 'Investigated a reported crash.', tags: ['debug'], taskIds: [], evidence: [] }
      await h.owner.edit({ id, expectedRevision: 0, activity, hidden: false }); await h.owner.sync()
      expect(h.owner.read(activity.day).weekly?.activities).toHaveLength(1)
      const correction = h.owner.read(activity.day).corrections[0]!
      await h.owner.edit({ ...correction, expectedRevision: 1, activity: { ...correction.activity, day: '2026-09-25' } }); await h.owner.sync()
      expect(h.owner.read('2026-09-28').weekly?.activities).toEqual([])
      expect(h.owner.read('2026-09-25').weekly?.activities).toHaveLength(1)
    } finally { await h.close() }
  })
  it('rejects invented citations, stops unchanged failed input at the retry budget, and allows explicit retry', async () => {
    const h = await setup()
    try {
      h.adapter.foreign = true
      for (let i = 0; i < 4; i++) await h.owner.sync()
      expect(h.adapter.calls).toHaveLength(3)
      expect(h.owner.read('2026-09-28').days[0]?.activities).toEqual([])
      expect(h.owner.read('2026-09-28').days[0]?.error).toContain('unavailable evidence')
      h.adapter.foreign = false; await h.owner.sync('2026-09-28')
      expect(h.owner.read('2026-09-28').days[0]?.activities).toHaveLength(1)
    } finally { await h.close() }
  })
  it('drains queued requested weeks even while a run is already active', async () => {
    const h = await setup()
    try {
      h.adapter.onCall = () => { delete h.adapter.onCall; void h.owner.sync('2026-09-21') }
      await h.owner.sync()
      expect(h.owner.read('2026-09-21').weekly?.error).toBeNull()
      expect(h.owner.read('2026-09-21').weekly?.activities).toEqual([])
    } finally { await h.close() }
  })
  it('logs the exact tool-free prompt before model access and rejects future results', async () => {
    const h = await setup()
    try {
      const audit = vi.fn(async (_id: string, _events: string) => {})
      h.adapter.onCall = () => { expect(audit).toHaveBeenCalledTimes(1) }
      const s = source('a'.repeat(64))
      const input = { kind: 'day', day: s.day, batch: [{ source: s }] }
      const result = await analyzeReview(h.h.ctx, h.h.config.briefPolish, JSON.stringify(input),
        new Set([s.id]), new Set(), audit, new AbortController().signal)
      const saved = JSON.parse(audit.mock.calls[0]![1]) as { data: unknown }[]
      expect(saved[0]?.data).toMatchObject({ system: REVIEW_PROMPT,
        input: JSON.stringify({ ...input, batch: [{ source: { ...s, id: 's1' } }] }), references: { s1: s.id } })
      expect(result[0]?.evidence).toEqual([s.id])
      expect({ system: REVIEW_PROMPT, input, result }).toMatchSnapshot()
      await expect(h.owner.edit({ id: reviewIdSchema.parse('future'), expectedRevision: 0, hidden: false,
        activity: { ...result[0]!, id: reviewIdSchema.parse('future'), day: '2026-10-01', evidence: [] } })).rejects.toThrow('future')
    } finally { await h.close() }
  })
  it('uses configured calendar midnight, including DST and week boundaries', () => {
    expect(reviewDay('2026-09-27T16:01:00Z', 'Asia/Shanghai')).toBe('2026-09-28')
    expect(reviewDay('2026-09-27T15:59:00Z', 'Asia/Shanghai')).toBe('2026-09-27')
    expect(reviewMonday('2026-09-27')).toBe('2026-09-21')
    expect(reviewMonday('2026-09-28')).toBe('2026-09-28')
    expect(reviewDay('2026-03-08T07:00:00Z', 'America/New_York')).toBe('2026-03-08')
  })
  it('reduces large daily input in bounded passes while retaining every source reference', async () => {
    const sources = Array.from({ length: 40 }, (_, i) => source(`long${i}`, '2026-09-28', 'x'.repeat(4000)))
    const h = await setup(sources)
    try {
      await h.owner.sync()
      const day = h.owner.read('2026-09-28').days[0]!
      expect(day.error).toBeNull()
      expect(day.activities[0]?.evidence.toSorted()).toEqual(sources.map(s => s.id).toSorted())
      expect(h.adapter.calls.every(call => JSON.stringify(call).length <= 8000)).toBe(true)
      expect(h.adapter.calls.filter(call => call.candidates).length).toBeGreaterThan(1)
    } finally { await h.close() }
  })
  it('aborts a model stream without publishing incomplete activities', async () => {
    const h = await setup()
    try {
      const controller = new AbortController()
      h.adapter.onCall = () => { controller.abort(new Error('Review owner closed')) }
      const input = JSON.stringify({ kind: 'day', day: '2026-09-28', batch: [{ source: source('s1') }] })
      await expect(analyzeReview(h.h.ctx, h.h.config.briefPolish, input, new Set(['s1']), new Set(), async () => {}, controller.signal))
        .rejects.toThrow('Review owner closed')
      expect(h.owner.read('2026-09-28').days[0]?.activities).toEqual([])
    } finally { await h.close() }
  })
  it('limits output content independently of stream fragmentation and repeated block-end payloads', async () => {
    const h = await setup()
    try {
      const input = JSON.stringify({ kind: 'day', day: '2026-09-28', batch: [{ source: source('s1') }] })
      const policy = { ...h.h.config.briefPolish, maxOutputBytes: 1024 }
      h.adapter.fragment = true
      const result = await analyzeReview(h.h.ctx, policy, input, new Set(['s1']), new Set(), async () => {}, new AbortController().signal)
      expect(result[0]?.title).toBe('Investigated reflection')
      h.adapter.output = 'x'.repeat(1025)
      await expect(analyzeReview(h.h.ctx, policy, input, new Set(['s1']), new Set(), async () => {}, new AbortController().signal))
        .rejects.toThrow('Review output exceeds its byte limit')
    } finally { await h.close() }
  })
  it('maps task and existing activity aliases back to durable identities', async () => {
    const h = await setup()
    try {
      const task = 'a5b79f86-f4cb-438d-8846-ff2791ddc403'
      const activity = reviewActivitySchema.parse({ id: 'a'.repeat(64), day: '2026-09-28', title: 'Debugged reflections',
        markdown: 'Confirmed one finding.', tags: ['debug'], taskIds: [task], evidence: ['b'.repeat(64)] })
      const input = { kind: 'day', day: activity.day, tasks: [{ id: task, title: 'Reflection task' }],
        candidates: [activity], previous: [{ id: activity.id, title: activity.title }] }
      const result = await analyzeReview(h.h.ctx, h.h.config.briefPolish, JSON.stringify(input),
        new Set(activity.evidence), new Set([task]), async () => {}, new AbortController().signal)
      expect(result).toEqual([activity])
      expect(h.adapter.calls[0]?.candidates?.[0]).toMatchObject({ id: 'a1', taskIds: ['t1'], evidence: ['s1'] })
    } finally { await h.close() }
  })
  it('assigns a program-owned identity when the model supplies an unknown activity alias', async () => {
    const h = await setup()
    try {
      h.adapter.activityId = 't1'
      await h.owner.sync()
      const activity = h.owner.read('2026-09-28').days[0]!.activities[0]!
      expect(h.owner.read('2026-09-28').days[0]?.error).toBeNull()
      expect(activity.id).not.toBe('t1')
      expect(activity.evidence).toEqual(['s1'])
      await h.reopen(); await h.owner.sync()
      expect(h.owner.read('2026-09-28').days[0]?.activities[0]?.id).toBe(activity.id)
    } finally { await h.close() }
  })
  it('publishes a large set of distinct activities that already fits the complete request budget', async () => {
    const sources = Array.from({ length: 3 }, (_, i) => source(`many${i}`, '2026-09-28', 'x'.repeat(2200)))
    const h = await setup(sources)
    try {
      h.adapter.output = 'x'.repeat(1500); h.adapter.preserveCandidates = true
      await h.owner.sync()
      const day = h.owner.read('2026-09-28').days[0]!
      expect(day.error).toBeNull()
      expect(day.activities.length).toBeGreaterThan(1)
      expect(new Set(day.activities.flatMap(a => a.evidence))).toEqual(new Set(sources.map(s => s.id)))
      expect(h.adapter.calls.every(call => JSON.stringify(call).length <= 8000)).toBe(true)
    } finally { await h.close() }
  })
})
