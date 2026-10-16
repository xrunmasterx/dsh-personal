/** One owner for dated review analysis, durable checkpoints and human corrections. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { Config } from './config.ts'
import { analyzeReview, REVIEW_PROMPT } from './review-analysis.ts'
import { reviewDay, reviewShift, reviewMonday, reviewHash, type ReviewInputs } from './review-sources.ts'
import { ReviewPolicySchema, reviewActivitySchema, reviewCorrectionSchema, reviewDaySchema, reviewDocumentSchema,
  reviewEditSchema, reviewIdSchema, reviewSourceSchema, reviewSourceIdSchema,
  type ReviewActivity, type ReviewEdit, type ReviewSource, type ReviewSourceId, type ReviewWeek } from './review-schema.ts'

const domain = defineDomain({ name: 'personal_retrospectives', version: 1, layout: 'per-record', tables: {
  reports: domainTable<string, z.infer<typeof reviewDocumentSchema>>(reviewDocumentSchema),
  corrections: domainTable<string, z.infer<typeof reviewCorrectionSchema>>(reviewCorrectionSchema),
  sources: domainTable<ReviewSourceId, ReviewSource>(reviewSourceSchema),
  chunks: domainTable<string, { activities: ReviewActivity[] }>(z.object({ activities: z.array(reviewActivitySchema) })),
  audit: domainTable<string, { events: string }>(z.object({ events: z.string() })),
} })

/** Scheduled analysis never writes tasks and never replaces human corrections. */
export class Reviews {
  private readonly policy
  private readonly lifetime = new AbortController()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Set<string>()
  private errors: string[] = []
  private tasks: ReviewInputs['tasks'] = []

  private constructor(private ctx: Context, private config: Config, private store: Domain<typeof domain>,
    private inputs: (from: string, to: string, zone: string) => ReviewInputs) {
    this.policy = ReviewPolicySchema(config.review)
    new Intl.DateTimeFormat('en-CA', { timeZone: this.policy.timeZone })
    if (this.policy.chunkChars * 2 > this.policy.maxInputChars) throw new Error('Review input must fit two source chunks')
  }

  /** Open retained reports without invoking a model.
   * @param ctx Storage and LLM services.
   * @param config Deployment limits.
   * @param inputs Current archived evidence reader.
   * @returns Owner requiring awaited close.
   */
  static async open(ctx: Context, config: Config, inputs: (from: string, to: string, zone: string) => ReviewInputs): Promise<Reviews> {
    const store = await ctx.storageDomain.open(domain)
    try {
      const owner = new Reviews(ctx, config, store, inputs)
      const today = reviewDay(new Date(), owner.policy.timeZone)
      const initial = inputs(today, today, owner.policy.timeZone)
      owner.tasks = initial.tasks; owner.errors = initial.errors
      return owner
    }
    catch (error) { await store.close(); throw error }
  }

  /** Begin automatic catch-up when enabled. */
  start(): void { if (this.policy.enabled) void this.sync() }

  private corrections() { return [...this.store.table('corrections').entries()].map(([, v]) => v) }
  private activities(): ReviewActivity[] {
    const edited = new Map(this.corrections().map(c => [c.id, c]))
    const generated = [...this.store.table('reports').entries()].filter(([key]) => key.startsWith('day_')).flatMap(([, d]) => d.activities)
    return [...generated.filter(a => !edited.has(a.id)), ...[...edited.values()].filter(c => !c.hidden).map(c => c.activity)]
  }

  /** Read daily cards, hidden corrections and the latest weekly synthesis.
   * @param day Any date of the selected week.
   * @returns Existing results; reads do not generate or schedule work.
   */
  read(day: string): ReviewWeek {
    reviewDaySchema.parse(day)
    const from = reviewMonday(day); const today = reviewDay(new Date(), this.policy.timeZone)
    const activities = this.activities()
    const daily = activities.filter(a => a.day >= from && a.day <= reviewShift(from, 6))
    const weekly = this.store.table('reports').get(`week_${from}`) ?? null
    const weekSources = [...new Set(daily.flatMap(a => a.evidence))].map(id => this.source(id))
    const incomplete = [...this.store.table('reports').entries()].some(([key, report]) => key.startsWith('day_') && report.day >= from && report.day <= reviewShift(from, 6) && report.error)
    const sourceIds = new Set([...daily, ...(weekly?.activities ?? [])].flatMap(a => a.evidence))
    return { from, today, timeZone: this.policy.timeZone, tasks: this.tasks, running: !!this.running, sourceErrors: this.errors,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = reviewShift(from, i); const report = this.store.table('reports').get(`day_${date}`)
        return { day: date, activities: activities.filter(a => a.day === date), updatedAt: report?.updatedAt || null,
          error: report?.error ?? null, stale: !!report && report.fingerprint !== report.attempted }
      }),
      weekly,
      weeklyStale: incomplete || (!!weekly && weekly.fingerprint !== this.fingerprint('week', from, weekSources, daily)),
      corrections: this.corrections().filter(c => c.activity.day >= from && c.activity.day <= reviewShift(from, 6)),
      sources: [...sourceIds].map((id) => {
        const { day, at, kind, label, role } = this.source(id)
        return { id, day, at, kind, label, role }
      }),
    }
  }

  /** Read the exact source snapshot cited by an activity.
   * @param id Published evidence identity.
   * @returns Retained source text and link.
   */
  source(id: ReviewSourceId): ReviewSource {
    const value = this.store.table('sources').get(reviewSourceIdSchema.parse(id))
    if (!value) throw new Error('Review source is unavailable')
    return value
  }

  /** Persist a human supplement, correction, hide decision or restoration.
   * @param input Full activity and displayed correction revision.
   * @returns Completion after a revision-checked write; background generation never changes this record.
   */
  edit(input: ReviewEdit): Promise<void> {
    const request = reviewEditSchema.parse(input)
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Reviews are closing'))
    const next = this.queue.then(async () => {
      const prior = this.store.table('corrections').get(request.id)
      if ((prior?.revision ?? 0) !== request.expectedRevision) throw new Error('Review was edited elsewhere; refresh before saving')
      if (request.id !== request.activity.id) throw new Error('Correction must retain its activity identity')
      if (request.activity.day > reviewDay(new Date(), this.policy.timeZone)) throw new Error('Review cannot record future activity')
      if (request.activity.evidence.some(id => !this.store.table('sources').get(id))) throw new Error('Correction contains an unknown source')
      const original = prior?.activity ?? this.activities().find(a => a.id === request.id)
      if (request.activity.taskIds.some(id => !this.tasks.some(task => task.id === id) && !original?.taskIds.includes(id))) {
        throw new Error('Correction references an unavailable task')
      }
      const activity = request.activity
      const id = reviewSourceIdSchema.parse(reviewHash(['note', request.id, (prior?.revision ?? 0) + 1]))
      await this.store.table('sources').put(id, { id, day: activity.day, at: new Date().toISOString(), kind: 'journal',
        label: activity.title, text: activity.markdown, role: 'user-review-correction', taskIds: activity.taskIds })
      await this.store.table('corrections').put(request.id, { ...request, activity: { ...activity, evidence: [...new Set([...activity.evidence, id])] }, revision: (prior?.revision ?? 0) + 1 })
      if (original) this.pending.add(reviewMonday(original.day))
    })
    this.queue = next.catch(() => undefined)
    return next.then(() => {
      for (const [key, report] of this.store.table('reports').entries()) {
        if (key.startsWith('day_') && report.activities.some(a => a.id === request.id)) this.pending.add(reviewMonday(report.day))
      }
      void this.sync(request.activity.day)
    })
  }

  /** Start or join one analysis run; requested weeks are queued instead of dropped.
   * @param day Optional week to backfill or retry.
   * @returns Shared completion; failures remain visible with the last published report.
   */
  sync(day?: string): Promise<void> {
    if (day) this.pending.add(reviewMonday(reviewDaySchema.parse(day)))
    if (this.lifetime.signal.aborted) return Promise.resolve()
    if (this.running) return this.running
    clearTimeout(this.timer)
    this.running = this.run().catch((error: unknown) => { this.errors = [String(error)] }).finally(() => {
      this.running = null
      if (this.pending.size && !this.lifetime.signal.aborted) void this.sync()
      else if (this.policy.enabled && !this.lifetime.signal.aborted) {
        this.timer = setTimeout(() => { void this.sync() }, this.policy.intervalMinutes * 60_000); this.timer.unref()
      }
    })
    return this.running
  }

  private fingerprint(kind: 'day' | 'week', day: string, sources: ReviewSource[], daily?: ReviewActivity[]): string {
    const corrections = kind === 'week' ? this.corrections().filter(c => c.activity.day >= day && c.activity.day <= reviewShift(day, 6)) : []
    return reviewHash([sources, daily, corrections, this.config.briefPolish, this.policy.timeZone, REVIEW_PROMPT])
  }

  private async analyze(input: { kind: 'day' | 'week'; day: string } & Record<string, unknown>, sources: ReviewSource[], tasks: ReviewInputs['tasks']): Promise<ReviewActivity[]> {
    const json = JSON.stringify(input)
    if (json.length > this.policy.maxInputChars) throw new Error('Review input exceeds configured limit; previous report is retained')
    const known = new Set([...this.store.table('reports').entries(), ...this.store.table('chunks').entries()].flatMap(([, d]) => d.activities.map(a => a.id)))
    for (const correction of this.corrections()) known.add(correction.id)
    const activities = await analyzeReview(this.ctx, this.config.briefPolish, json, new Set(sources.map(s => s.id)),
      new Set(tasks.map(t => t.id)), async (id, events) => { await this.store.table('audit').put(id, { events }) }, this.lifetime.signal)
    for (const activity of activities) {
      if (!activity.id.startsWith('new:') && !known.has(activity.id)) throw new Error('Review returned an unknown activity ID')
      if (activity.day > reviewDay(new Date(), this.policy.timeZone)) throw new Error('Review cannot invent future activity')
      if (input.kind === 'day' && activity.day !== input.day) {
        const correction = this.corrections().find(c => c.id === activity.id && c.activity.day === activity.day)
        if (!correction) throw new Error('Review activity must stay on its source day; use a correction to move it')
      }
      if (activity.id.startsWith('new:')) activity.id = reviewIdSchema.parse(reviewHash([activity.day, activity.title, [...activity.evidence].sort()]))
    }
    if (new Set(activities.map(a => a.id)).size !== activities.length) throw new Error('Review returned duplicate activities')
    return activities
  }

  private async cachedAnalysis(input: { kind: 'day' | 'week'; day: string } & Record<string, unknown>, sources: ReviewSource[], tasks: ReviewInputs['tasks']): Promise<ReviewActivity[]> {
    const id = reviewHash([input, this.config.briefPolish, REVIEW_PROMPT])
    const cached = this.store.table('chunks').get(id)
    if (cached) return cached.activities
    const activities = await this.analyze(input, sources, tasks)
    await this.store.table('chunks').put(id, { activities })
    return activities
  }

  private async condense(base: { kind: 'day' | 'week'; day: string }, initial: ReviewActivity[], sources: ReviewSource[], tasks: ReviewInputs['tasks']): Promise<ReviewActivity[]> {
    let activities = initial
    const limit = this.policy.maxInputChars
    while (JSON.stringify({ ...base, candidates: activities }).length > limit) {
      const groups: ReviewActivity[][] = []; let group: ReviewActivity[] = []
      for (const activity of activities) {
        if (JSON.stringify({ ...base, candidates: [activity] }).length > limit) throw new Error('One review activity exceeds the input limit')
        if (group.length && JSON.stringify({ ...base, candidates: [...group, activity] }).length > limit) { groups.push(group); group = [] }
        group.push(activity)
      }
      if (group.length) groups.push(group)
      const reduced: ReviewActivity[] = []
      for (const candidates of groups) {
        this.lifetime.signal.throwIfAborted()
        reduced.push(...await this.cachedAnalysis({ ...base, candidates }, sources, tasks))
      }
      if (JSON.stringify(reduced).length >= JSON.stringify(activities).length) throw new Error('Review consolidation did not reduce input size')
      activities = reduced
    }
    return activities
  }

  private async generate(kind: 'day' | 'week', day: string, sources: ReviewSource[], tasks: ReviewInputs['tasks'], retry: boolean,
    daily?: ReviewActivity[]): Promise<void> {
    const key = `${kind}_${day}`; const previous = this.store.table('reports').get(key)
    const corrections = this.corrections().filter(c => c.activity.day >= day && c.activity.day <= (kind === 'day' ? day : reviewShift(day, 6))
      || previous?.activities.some(a => a.id === c.id))
    const fingerprint = this.fingerprint(kind, day, sources, daily)
    if (previous?.fingerprint === fingerprint
      || (!retry && previous?.attempted === fingerprint && previous.failures >= this.policy.maxAttempts)) return
    try {
      for (const source of sources) await this.store.table('sources').put(source.id, source)
      const base = { kind, day, timeZone: this.policy.timeZone, tasks }
      const identities = previous?.activities.map(({ id, title }) => ({ id, title })) ?? []
      const publication = { ...base, previous: identities, corrections }
      let activities: ReviewActivity[] = []
      if (kind === 'week' && daily?.length) {
        const candidates = await this.condense(publication, daily, sources, tasks)
        activities = await this.analyze({ ...publication, daily: candidates }, sources, tasks)
      }
      else if (kind === 'day' && sources.length) {
        const batches: { source: ReviewSource; part: number; parts: number }[][] = []; let batch: typeof batches[number] = []
        for (const source of sources) {
          const parts = Math.max(1, Math.ceil(source.text.length / this.policy.chunkChars))
          for (let part = 0; part < parts; part++) {
            const text = source.text.slice(part * this.policy.chunkChars, (part + 1) * this.policy.chunkChars)
            const entry = { source: { ...source, text }, part, parts }
            if (batch.length && JSON.stringify({ ...base, batch: [...batch, entry] }).length > this.policy.maxInputChars / 2) {
              batches.push(batch); batch = []
            }
            batch.push(entry)
          }
        }
        if (batch.length) batches.push(batch)
        const chunks: ReviewActivity[] = []
        for (const entries of batches) {
          this.lifetime.signal.throwIfAborted()
          chunks.push(...await this.cachedAnalysis({ ...base, batch: entries }, entries.map(e => e.source), tasks))
        }
        const allowed = [...sources, ...corrections.flatMap(c => c.activity.evidence.map(id => this.source(id)))]
        const candidates = await this.condense(publication, chunks, allowed, tasks)
        activities = candidates.length
          ? await this.analyze({ ...publication, candidates }, allowed, tasks) : []
      }
      this.lifetime.signal.throwIfAborted()
      if (kind === 'week') for (const activity of activities) activity.day = day
      await this.store.table('reports').put(key, { day, fingerprint, activities, updatedAt: new Date().toISOString(), error: null, attempted: fingerprint, failures: 0 })
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      await this.store.table('reports').put(key, { day, fingerprint: previous?.fingerprint ?? '', activities: previous?.activities ?? [],
        updatedAt: previous?.updatedAt ?? '', error: String(error), attempted: fingerprint,
        failures: previous?.attempted === fingerprint ? previous.failures + 1 : 1 })
    }
  }

  private async run(): Promise<void> {
    do {
      const requested = [...this.pending]; this.pending.clear()
      const today = reviewDay(new Date(), this.policy.timeZone)
      const recent = reviewMonday(reviewShift(today, 1 - this.policy.lookbackDays))
      const from = requested.reduce((earliest, day) => day < earliest ? day : earliest, recent)
      const inputs = this.inputs(from, today, this.policy.timeZone); this.errors = inputs.errors; this.tasks = inputs.tasks
      const requestedDays = requested.flatMap(d => Array.from({ length: 7 }, (_, i) => reviewShift(d, i)))
      const recentDays: string[] = []
      for (let day = recent; day <= today; day = reviewShift(day, 1)) recentDays.push(day)
      const dates = new Set([...recentDays, ...requestedDays].filter(day => day <= today))
      for (const day of [...dates].sort()) {
        this.lifetime.signal.throwIfAborted()
        if (day > today) continue
        await this.generate('day', day, inputs.sources.filter(s => s.day === day), inputs.tasks, requested.includes(reviewMonday(day)))
      }
      await this.queue
      const activities = this.activities()
      const weeks = new Set([...dates].map(reviewMonday))
      for (const from of weeks) {
        this.lifetime.signal.throwIfAborted()
        if (from > today) continue
        const to = reviewShift(from, 6)
        const reports = [...this.store.table('reports').entries()].filter(([key, d]) => key.startsWith('day_') && d.day >= from && d.day <= to)
        if (reports.some(([, d]) => d.error)) continue
        const daily = activities.filter(a => a.day >= from && a.day <= to)
        const ids = new Set(daily.flatMap(a => a.evidence))
        const sources = [...ids].map(id => this.source(id))
        await this.generate('week', from, sources, inputs.tasks, requested.includes(from), daily)
      }
    } while (this.pending.size && !this.lifetime.signal.aborted)
  }

  /** Stop scheduling, abort analysis and drain writes before closing storage. */
  async close(): Promise<void> {
    clearTimeout(this.timer); this.lifetime.abort()
    await this.running; await this.queue; await this.store.close()
  }
}
