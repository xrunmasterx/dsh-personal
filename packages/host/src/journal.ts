/** Durable personal work records, independent of provider caches and agent sessions. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { taskImageReferences, type TaskImages } from './task-images.ts'

/** Stable identities for journal records and idempotent operations. */
export type JournalId = Branded<'PersonalJournalId'>
/** Provider-addressed DSH session identity retained by a work item. */
export type TaskSessionId = Branded<'PersonalTaskSessionId'>
const id = z.uuid().transform(value => brandString<JournalId>(value))
const taskSessionInput = z.object({
  id: z.uuid().transform(value => brandString<TaskSessionId>(value)),
  title: z.string().trim().min(1).max(1000),
  state: z.enum(['pending', 'ready']),
  summary: z.string().trim().max(2000).optional(),
})
const taskSession = taskSessionInput.extend({ provider: z.literal('dsh'), createdAt: z.iso.datetime() })
/** Durable association; pending entries can resume the same preallocated native session. */
export type TaskSession = z.infer<typeof taskSession>
const day = z.iso.date()
const text = z.string().trim().max(20_000)
const status = z.enum(['todo', 'active', 'blocked', 'done', 'canceled'])
const link = z.object({
  title: z.string().max(1000),
  url: z.url().refine(value => /^https?:\/\//.test(value)),
})
const plan = z
  .object({
    day,
    intention: text,
    start: z.iso.time({ precision: -1 }).nullable(),
    end: z.iso.time({ precision: -1 }).nullable(),
  })
  .refine(
    value =>
      (!value.start && !value.end) ||
      (typeof value.start === 'string' && typeof value.end === 'string' && value.start < value.end),
    'Provide both times in increasing order',
  )
const timeline = z
  .object({ from: day, to: day, followToday: z.boolean().optional() })
  .refine(value => value.from <= value.to, 'Timeline dates must be ordered')
const item = z.object({
  id,
  title: z.string().trim().min(1).max(1000),
  status,
  nextAction: text,
  links: z.array(link).max(50),
  plans: z.array(plan).max(366),
  createdOn: day,
  timeline: timeline.optional(),
  description: text.optional(),
  summary: z.string().trim().max(160).optional(),
  sessions: z.array(taskSession).optional(),
})
const log = z.object({ day, text: text.min(1), minutes: z.number().int().nonnegative().nullable() })
const event = z.object({
  id,
  itemId: id,
  revision: z.number().int().positive(),
  at: z.iso.datetime(),
  day,
  operation: z.enum(['create', 'update', 'plan', 'unplan', 'progress', 'delete', 'reorder', 'undo']),
  before: item.nullable(),
  after: item.nullable(),
  log: log.nullable(),
  reason: text,
  reverts: id.nullable(),
  requestHash: z.string(),
  ordering: z.object({ version: z.number().int().positive(), items: z.array(id) }).optional(),
})

/** Validated write request shared by direct editing and native DSH tools. */
export const journalWriteSchema = z
  .object({
    requestId: id,
    itemId: id,
    expectedRevision: z.number().int().nonnegative(),
    operation: z.enum(['create', 'update', 'plan', 'unplan', 'progress', 'delete', 'reorder', 'undo']),
    day,
    title: z.string().trim().min(1).max(1000).optional(),
    status: status.optional(),
    nextAction: text.optional(),
    description: text.optional(),
    summary: z.string().trim().max(160).optional(),
    taskSession: taskSessionInput.optional(),
    links: z.array(link).max(50).optional(),
    text: text.optional(),
    minutes: z.number().int().nonnegative().nullable().optional(),
    plan: plan.optional(),
    replaceDay: day.optional(),
    timeline: timeline.nullable().optional(),
    reorderBefore: id.nullable().optional(),
    reason: text.min(1),
  })
  .strict()

/** One user-owned work item, with no mandatory provider identity. */
export type JournalItem = z.infer<typeof item>
/** Immutable mutation receipt; progress records carry their actual occurrence date. */
export type JournalEvent = z.infer<typeof event>
/** Revision-checked single-item mutation. */
export type JournalWrite = z.infer<typeof journalWriteSchema>
/** Actual execution dates reconstructed from non-reverted status transitions. */
export interface JournalExecution {
  startedAt: string
  startedOn: string
  endedAt: string | null
  endedOn: string | null
}
/** Current item together with the receipt needed to edit or undo it. */
export interface JournalRow {
  item: JournalItem
  revision: number
  eventId: JournalId
  /** Position in the persistent execution list; absent for backlog items. */
  order?: number
  execution?: JournalExecution
}
/** Bounded day or item search; null dates include all days. */
export interface JournalQuery {
  from: string | null
  to: string | null
  text: string
  offset: number
  includeOpen: boolean
}
/** Page of current items selected by their present state or dated history. */
export interface JournalPage {
  items: JournalRow[]
  total: number
  nextOffset: number | null
}
/** Evidence for a Monday-to-Sunday personal retrospective. Read every page before drafting. */
export interface JournalWeek {
  from: string
  to: string
  fingerprint: string
  page: JournalPage
}
const report = z.object({
  id,
  version: z.number().int().positive(),
  from: day,
  to: day,
  fingerprint: z.string(),
  markdown: text.min(1),
  references: z.array(id),
  at: z.iso.datetime(),
})
/** Editable retrospective version, tied to journal evidence at generation time. */
export type JournalReport = z.infer<typeof report>
/** Persist a new retrospective version without replacing earlier edits. */
export const journalReportSchema = report
  .omit({ at: true, to: true, version: true })
  .extend({ expectedReportId: id.nullable(), kind: z.enum(['generate', 'edit']) })
/** Retrospective edit with optimistic concurrency against the displayed version. */
export type JournalReportWrite = z.infer<typeof journalReportSchema>

const journalDomain = defineDomain({
  name: 'personal_work_journal',
  version: 1,
  layout: 'per-record',
  tables: {
    events: domainTable<JournalId, JournalEvent>(event),
    reports: domainTable<JournalId, JournalReport>(report),
  },
})

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function interval(from: string): { from: string; to: string } {
  day.parse(from)
  const start = new Date(`${from}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}

/** One serialized writer; each item change and its history commit as a single record. */
export class WorkJournal {
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private eventCache: JournalEvent[] | undefined
  private currentCache: Map<JournalId, JournalEvent> | undefined
  private executionCache: Map<JournalId, JournalExecution> | undefined
  private orderCache: JournalId[] | undefined
  private rowCache: JournalRow[] | undefined
  private constructor(
    private readonly domain: Domain<typeof journalDomain>,
    private readonly pageSize: number,
    private readonly maxBytes: number,
    private readonly images?: TaskImages,
  ) {}

  /**
   * Open durable work history outside cache retention.
   * @param ctx - configured storage owner.
   * @param pageSize - deployed page bound.
   * @param maxBytes - complete response and record byte bound.
   * @param images Optional task-owned image lifecycle for the deployed Host.
   * @returns initialized journal.
   */
  static async open(ctx: Context, pageSize: number, maxBytes: number, images?: TaskImages): Promise<WorkJournal> {
    return new WorkJournal(await ctx.storageDomain.open(journalDomain), pageSize, maxBytes, images)
  }

  /** Upload under the same lock as task writes and collection.
   * @param data Canonical base64 bytes.
   * @param mediaType Declared raster format.
   * @returns Durable task image destination.
   */
  uploadImage(data: string, mediaType: string): Promise<string> {
    return this.serialize(() => {
      if (!this.images) throw new Error('Task image storage is not configured')
      return this.images.upload(data, mediaType)
    })
  }

  /** Read while excluding physical collection.
   * @param destination Versioned image reference.
   * @returns Verified raster data URL.
   */
  readImage(destination: string): Promise<string> {
    return this.serialize(() => {
      if (!this.images) throw new Error('Task image storage is not configured')
      return this.images.read(destination)
    })
  }

  /** Collect unreferenced images after their history retention period.
   * @returns Number of physically removed files.
   */
  collectImages(): Promise<number> {
    return this.serialize(async () => {
      if (!this.images) return 0
      const references = new Map<string, number>()
      for (const entry of this.allEvents()) {
        for (const ref of taskImageReferences(JSON.stringify(entry)))
          references.set(ref, Math.max(references.get(ref) ?? 0, Date.parse(entry.at)))
      }
      for (const entry of this.current().values()) {
        if (entry.after) for (const ref of taskImageReferences(JSON.stringify(entry.after))) references.set(ref, Infinity)
      }
      return this.images.collect(references, Date.now())
    })
  }

  private bounded<T>(value: T): T {
    if (Buffer.byteLength(JSON.stringify(value)) > this.maxBytes)
      throw new Error('Journal response exceeds the configured limit; narrow the date range or page size')
    return value
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Journal is closing'))
    const pending = this.queue.then(fn)
    this.queue = pending.catch(() => undefined)
    return pending
  }
  private allEvents(): JournalEvent[] {
    return (this.eventCache ??= [...this.domain.table('events').entries()].map(([, value]) => value))
  }
  private current(): Map<JournalId, JournalEvent> {
    if (this.currentCache) return this.currentCache
    const latest = new Map<JournalId, JournalEvent>()
    for (const entry of this.allEvents()) {
      const previous = latest.get(entry.itemId)
      if (!previous || previous.revision < entry.revision) latest.set(entry.itemId, entry)
    }
    return (this.currentCache = latest)
  }

  private executions(): Map<JournalId, JournalExecution> {
    if (this.executionCache) return this.executionCache
    const events = this.allEvents()
    const reverted = new Set(events.flatMap(entry => (entry.reverts ? [entry.reverts] : [])))
    const result = new Map<JournalId, JournalExecution>()
    for (const entry of [...events].sort((a, b) => a.revision - b.revision)) {
      if (entry.operation === 'undo' || reverted.has(entry.id)) continue
      const value = entry.after
      if (!value || value.status === 'todo') {
        result.delete(entry.itemId)
        continue
      }
      if (entry.before?.status === value.status) continue
      const current = result.get(entry.itemId)
      if (value.status === 'active' || value.status === 'blocked') {
        result.set(
          entry.itemId,
          current
            ? { ...current, endedAt: null, endedOn: null }
            : { startedAt: entry.at, startedOn: entry.day, endedAt: null, endedOn: null },
        )
      } else if (current) {
        result.set(entry.itemId, { ...current, endedAt: entry.at, endedOn: entry.day })
      }
    }
    return (this.executionCache = result)
  }

  private latestOrdering(): JournalEvent['ordering'] {
    const events = this.allEvents()
    const reverted = new Set(events.flatMap(entry => (entry.reverts ? [entry.reverts] : [])))
    let latest: JournalEvent['ordering']
    for (const entry of events) {
      if (entry.ordering && !reverted.has(entry.id) && entry.ordering.version > (latest?.version ?? 0))
        latest = entry.ordering
    }
    return latest
  }

  private orderedItems(): JournalId[] {
    if (this.orderCache) return this.orderCache
    const ordering = this.latestOrdering()
    const execution = this.executions()
    const current = [...this.current().values()]
      .filter(entry => entry.after && entry.after.status !== 'todo')
      .sort(
        (a, b) =>
          (execution.get(a.itemId)?.startedAt ?? a.at).localeCompare(
            execution.get(b.itemId)?.startedAt ?? b.at,
          ) || a.itemId.localeCompare(b.itemId),
      )
      .map(entry => entry.itemId)
    const live = new Set(current)
    const retained = ordering?.items.filter(itemId => live.has(itemId)) ?? []
    const present = new Set(retained)
    return (this.orderCache = [...retained, ...current.filter(itemId => !present.has(itemId))])
  }

  private rows(): JournalRow[] {
    if (this.rowCache) return this.rowCache
    const executions = this.executions()
    const positions = new Map(this.orderedItems().map((itemId, index) => [itemId, index]))
    this.rowCache = [...this.current().values()]
      .sort((a, b) => b.at.localeCompare(a.at) || a.itemId.localeCompare(b.itemId))
      .flatMap((entry) => {
        if (!entry.after) return []
        const execution = executions.get(entry.itemId)
        const order = positions.get(entry.itemId)
        return [
          {
            item: entry.after,
            revision: entry.revision,
            eventId: entry.id,
            ...(execution ? { execution } : {}),
            ...(order !== undefined ? { order } : {}),
          },
        ]
      })
    return this.rowCache
  }

  private ordering(items: JournalId[]): NonNullable<JournalEvent['ordering']> {
    return {
      version:
        this.allEvents().reduce((maximum, entry) => Math.max(maximum, entry.ordering?.version ?? 0), 0) + 1,
      items,
    }
  }

  /**
   * Read one current task, rejecting deleted or unknown identities.
   * @param itemId - saved task identity.
   * @returns the current revision and task document.
   */
  readItem(itemId: JournalId): JournalRow {
    const row = this.rows().find(row => row.item.id === id.parse(itemId))
    if (!row) throw new Error('Work item not found')
    return row
  }

  /**
   * Original immutable receipt.
   * @param eventId - cited receipt identity.
   * @returns original immutable receipt.
   */
  readEvent(eventId: JournalId): JournalEvent {
    const value = this.domain.table('events').get(id.parse(eventId))
    if (!value) throw new Error('Work record not found')
    return this.bounded(value)
  }

  /**
   * Read current items matching dates, including moved plans and undone receipts.
   * @param query - date, text and offset filters.
   * @returns bounded page; nextOffset must be followed to exhaust results.
   */
  query(query: JournalQuery): JournalPage {
    z.object({
      from: day.nullable(),
      to: day.nullable(),
      text,
      offset: z.number().int().nonnegative(),
      includeOpen: z.boolean(),
    }).parse(query)
    if (Boolean(query.from) !== Boolean(query.to) || (query.from && query.to && query.from > query.to))
      throw new Error('Provide an ordered date range')
    const within = (value: string) =>
      !query.from || (query.to !== null && value >= query.from && value <= query.to)
    const overlaps = (from: string, to: string | null) =>
      !query.from || (query.to !== null && from <= query.to && (to === null || to >= query.from))
    const matching = new Set<JournalId>()
    if (query.from) {
      for (const entry of this.allEvents()) {
        if (
          within(entry.day) ||
          entry.before?.plans.some(p => within(p.day)) ||
          entry.after?.plans.some(p => within(p.day))
        )
          matching.add(entry.itemId)
      }
    }
    const needle = query.text.toLowerCase()
    const rows =
      !query.from && !needle
        ? this.rows()
        : this.rows().filter(
          row =>
            (!query.from ||
                matching.has(row.item.id) ||
                (row.item.timeline && overlaps(row.item.timeline.from, row.item.timeline.to)) ||
                (row.execution && overlaps(row.execution.startedOn, row.execution.endedOn)) ||
                row.item.plans.some(p => within(p.day)) ||
                (query.includeOpen && !['done', 'canceled'].includes(row.item.status))) &&
              `${row.item.title} ${row.item.nextAction}`.toLowerCase().includes(needle),
        )
    const selected = rows.slice(query.offset, query.offset + this.pageSize)
    return this.bounded({
      items: selected,
      total: rows.length,
      nextOffset: query.offset + selected.length < rows.length ? query.offset + selected.length : null,
    })
  }

  /**
   * Read immutable receipts for an item, including corrections and reverts.
   * @param itemId - retained item identity.
   * @param offset - history cursor.
   * @returns newest-first history and next cursor.
   */
  history(itemId: JournalId, offset: number): { events: JournalEvent[]; nextOffset: number | null } {
    id.parse(itemId)
    z.number().int().nonnegative().parse(offset)
    const entries = this.allEvents()
      .filter(entry => entry.itemId === itemId)
      .sort((a, b) => b.revision - a.revision)
    return this.bounded({
      events: entries.slice(offset, offset + this.pageSize),
      nextOffset: offset + this.pageSize < entries.length ? offset + this.pageSize : null,
    })
  }

  /**
   * Read dated changes with explicit pagination and undo markers, including removed items.
   * @param from - first included date.
   * @param to - last included date.
   * @param offset - activity cursor.
   * @returns dated receipts and undone identities in this page.
   */
  activity(
    from: string,
    to: string,
    offset: number,
  ): { events: JournalEvent[]; revertedIds: JournalId[]; nextOffset: number | null } {
    day.parse(from)
    day.parse(to)
    z.number().int().nonnegative().parse(offset)
    if (from > to) throw new Error('Provide an ordered date range')
    const all = this.allEvents()
    const reverted = new Set(all.flatMap(entry => (entry.reverts ? [entry.reverts] : [])))
    const selected = all
      .filter(
        entry =>
          (entry.day >= from && entry.day <= to) ||
          entry.before?.plans.some(p => p.day >= from && p.day <= to) ||
          entry.after?.plans.some(p => p.day >= from && p.day <= to),
      )
      .sort((a, b) => b.at.localeCompare(a.at) || b.revision - a.revision)
    const page = selected.slice(offset, offset + this.pageSize)
    return this.bounded({
      events: page,
      revertedIds: page.filter(entry => reverted.has(entry.id)).map(entry => entry.id),
      nextOffset: offset + this.pageSize < selected.length ? offset + this.pageSize : null,
    })
  }

  /**
   * Commit one explicit user change, rejecting stale edits and conflicting retry identities.
   * @param input - complete revision-bound operation; undo only targets the latest item revision.
   * @param conversation - native session association committed with this change; supplied by the session-aware tool owner.
   * @returns durable receipt after persistence succeeds.
   */
  async write(input: JournalWrite, conversation?: Pick<TaskSession, 'id' | 'title' | 'summary'>): Promise<JournalEvent> {
    const request = journalWriteSchema.parse(input)
    return this.serialize(async () => {
      const requestHash = hash(conversation ? { request, conversation } : request)
      const previous = this.domain.table('events').get(request.requestId)
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new Error('Request identity was already used for another change')
        return previous
      }
      const latest = this.current().get(request.itemId)
      if ((latest?.revision ?? 0) !== request.expectedRevision)
        throw new Error('This item changed; refresh before editing or undoing')
      const before = latest?.after ?? null
      let after = before ? structuredClone(before) : null
      let progress: JournalEvent['log'] = null
      let reverts: JournalId | null = null
      let ordering: JournalEvent['ordering']
      switch (request.operation) {
        case 'create':
          if (latest || !request.title) throw new Error('Create requires a new item identity and title')
          after = {
            id: request.itemId,
            title: request.title,
            status: request.status ?? 'todo',
            nextAction: request.nextAction ?? '',
            links: request.links ?? [],
            plans: [],
            createdOn: request.day,
          }
          if (request.plan) after.plans.push(request.plan)
          if (request.text)
            progress = { day: request.day, text: request.text, minutes: request.minutes ?? null }
          break
        case 'delete':
          if (!after) throw new Error('The work item does not exist')
          after = null
          break
        case 'reorder': {
          if (!after || after.status === 'todo') throw new Error('Only execution items can be reordered')
          if (request.reorderBefore === undefined)
            throw new Error('Specify a target item or null for the end')
          const items = this.orderedItems().filter(itemId => itemId !== request.itemId)
          const target = request.reorderBefore === null ? items.length : items.indexOf(request.reorderBefore)
          if (target < 0) throw new Error('The target item changed; refresh before reordering')
          items.splice(target, 0, request.itemId)
          ordering = this.ordering(items)
          break
        }
        case 'undo':
          if (!latest || latest.operation === 'undo') throw new Error('No reversible latest change')
          if (latest.operation === 'reorder' && latest.ordering?.version !== this.latestOrdering()?.version)
            throw new Error('Board order changed; refresh before undoing a reorder')
          after = latest.before
          reverts = latest.id
          break
        default:
          if (!after) throw new Error('The work item does not exist')
          if (request.operation === 'plan') {
            const selectedPlan = request.plan
            if (!selectedPlan) throw new Error('A daily plan is required')
            if (request.replaceDay && !after.plans.some(p => p.day === request.replaceDay))
              throw new Error('The original plan no longer exists')
            after.plans = [
              ...after.plans.filter(p => p.day !== selectedPlan.day && p.day !== request.replaceDay),
              selectedPlan,
            ].sort((a, b) => a.day.localeCompare(b.day))
          } else if (request.operation === 'unplan') {
            if (!after.plans.some(p => p.day === request.day))
              throw new Error('No plan exists for this day')
            after.plans = after.plans.filter(p => p.day !== request.day)
          } else if (request.operation === 'progress' || request.text) {
            if (!request.text) throw new Error('Progress requires an actual work description')
            progress = { day: request.day, text: request.text, minutes: request.minutes ?? null }
          }
          if (request.title !== undefined) after.title = request.title
          if (request.status !== undefined) after.status = request.status
          if (request.nextAction !== undefined) after.nextAction = request.nextAction
          if (request.links !== undefined) after.links = request.links
      }
      if (
        after &&
        request.operation !== 'undo' &&
        request.operation !== 'reorder' &&
        request.timeline !== undefined
      ) {
        if (request.timeline === null) delete after.timeline
        else after.timeline = request.timeline
      }
      if (request.description !== undefined || request.taskSession !== undefined) {
        if (!after || !['create', 'update'].includes(request.operation))
          throw new Error('Task descriptions and sessions require create or update')
        if (request.description !== undefined) after.description = request.description
        if (request.taskSession) {
          const incoming = request.taskSession
          const sessions = after.sessions ?? []
          const existing = sessions.find(value => value.id === incoming.id)
          if (!existing && incoming.state !== 'pending')
            throw new Error('Reserve the task session before making it ready')
          if (
            existing &&
            (existing.title !== incoming.title ||
              (existing.state === 'ready' && incoming.state === 'pending'))
          )
            throw new Error('Task session identity or lifecycle conflicts with the stored association')
          after.sessions = existing
            ? sessions.map(value =>
              value.id === incoming.id ? { ...value, state: incoming.state } : value,
            )
            : [...sessions, { ...incoming, provider: 'dsh', createdAt: new Date().toISOString() }]
        }
      }
      if (conversation) {
        if (!after || !['create', 'update', 'progress'].includes(request.operation))
          throw new Error('Conversation updates require a live work item')
        const existing = after.sessions?.find(link => link.id === conversation.id)
        const association = taskSession.parse({ ...conversation, title: existing?.title ?? conversation.title,
          state: 'ready', provider: 'dsh', createdAt: existing?.createdAt ?? new Date().toISOString() })
        after.sessions = existing
          ? after.sessions?.map(link => link.id === conversation.id ? association : link)
          : [...(after.sessions ?? []), association]
      }
      if (after && request.operation !== 'undo') {
        if (before?.description !== after.description || before?.status !== after.status) delete after.summary
        if (request.summary !== undefined) {
          if (!['create', 'update'].includes(request.operation) || request.description === undefined)
            throw new Error('A task summary must be saved with its description')
          after.summary = request.summary
        }
      } else if (request.summary !== undefined) {
        throw new Error('A task summary requires create or update')
      }
      const wasOngoing = before !== null && before.status !== 'todo'
      const isOngoing = after !== null && after.status !== 'todo'
      if (request.operation !== 'undo' && wasOngoing !== isOngoing) {
        const items = this.orderedItems().filter(itemId => itemId !== request.itemId)
        if (isOngoing) {
          const target = request.reorderBefore == null ? items.length : items.indexOf(request.reorderBefore)
          if (target < 0) throw new Error('The target item changed; refresh before starting work')
          items.splice(target, 0, request.itemId)
        }
        ordering = this.ordering(items)
      }
      const receipt = event.parse({
        id: request.requestId,
        itemId: request.itemId,
        revision: request.expectedRevision + 1,
        at: new Date().toISOString(),
        day: request.day,
        operation: request.operation,
        before,
        after,
        log: progress,
        reason: request.reason,
        reverts,
        requestHash,
        ...(ordering ? { ordering } : {}),
      })
      this.bounded(receipt)
      if (after && this.images && after.description !== before?.description)
        await this.images.validate(after.description ?? '')
      await this.domain.table('events').put(receipt.id, receipt)
      this.eventCache = undefined
      this.currentCache = undefined
      this.executionCache = undefined
      this.orderCache = undefined
      this.rowCache = undefined
      return receipt
    })
  }

  /**
   * Read facts for the selected natural week; the fingerprint also covers open-work changes.
   * @param selectedDay - any date in the selected week.
   * @param offset - item cursor, followed by each item's history cursors for complete evidence.
   * @returns evidence page and a fingerprint for saving a retrospective.
   */
  week(selectedDay: string, offset: number): JournalWeek {
    const range = interval(selectedDay)
    const versions = [...this.current().values()]
      .map(entry => [entry.itemId, entry.revision])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return this.bounded({
      ...range,
      fingerprint: hash(versions),
      page: this.query({ ...range, text: '', offset, includeOpen: true }),
    })
  }

  /**
   * Read the latest saved retrospective for the selected week.
   * @param selectedDay - any day of that week.
   * @returns latest version or null; stale indicates changed source records.
   */
  report(selectedDay: string): { report: JournalReport | null; stale: boolean } {
    const week = this.week(selectedDay, 0)
    const records = [...this.domain.table('reports').entries()]
      .map(([, value]) => value)
      .filter(value => value.from === week.from)
    const latest = records.sort((a, b) => b.version - a.version)[0] ?? null
    return this.bounded({ report: latest, stale: Boolean(latest && latest.fingerprint !== week.fingerprint) })
  }

  /**
   * Save an editable DSH-generated or user-edited retrospective with verified evidence references.
   * @param input - current evidence fingerprint and displayed report version.
   * @returns new durable version; generation rejects stale sources, and every save rejects stale report identities.
   */
  async saveReport(input: JournalReportWrite): Promise<JournalReport> {
    const request = journalReportSchema.parse(input)
    return this.serialize(async () => {
      const week = this.week(request.from, 0)
      const current = this.report(week.from).report
      if (
        request.from !== week.from ||
        (request.kind === 'generate' && week.fingerprint !== request.fingerprint)
      )
        throw new Error('Work records changed; read the week again before saving')
      if (this.domain.table('reports').get(request.id)) throw new Error('Report identity already exists')
      if (
        request.kind === 'edit' &&
        (!current ||
          current.fingerprint !== request.fingerprint ||
          hash(current.references) !== hash(request.references))
      )
        throw new Error('Manual edits must retain the displayed source records')
      if ((current?.id ?? null) !== request.expectedReportId)
        throw new Error('The retrospective was edited; reload before saving')
      if (request.references.length === 0) throw new Error('A retrospective requires work-record references')
      for (const reference of request.references) {
        const entry = this.domain.table('events').get(reference)
        if (!entry) throw new Error('Unknown work-record reference')
        const currentItem = this.current().get(entry.itemId)?.after
        const relevant =
          (entry.day >= week.from && entry.day <= week.to) ||
          entry.before?.plans.some(p => p.day >= week.from && p.day <= week.to) ||
          entry.after?.plans.some(p => p.day >= week.from && p.day <= week.to) ||
          (currentItem && !['done', 'canceled'].includes(currentItem.status))
        if (request.kind === 'generate' && !relevant)
          throw new Error('Reference is outside this week and its remaining work')
      }
      const value = report.parse({
        ...request,
        version: (current?.version ?? 0) + 1,
        to: week.to,
        at: new Date().toISOString(),
      })
      this.bounded(value)
      await this.domain.table('reports').put(value.id, value)
      return value
    })
  }

  /** Drain admitted writes before releasing durable storage. */
  async close(): Promise<void> {
    this.closed = true
    await this.queue
    await this.domain.close()
  }
}
