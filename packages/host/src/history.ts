/** Personal archive owner: serialized commits, incremental model calls and Host-owned scheduling. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { analyzeHistory } from './history-analysis.ts'
import { historyExcerpt, historyTaskInput } from './history-input.ts'
import { HistoryReaders, historyId, historyHash } from './history-readers.ts'
import { HistoryPolicySchema, HistoryPreferenceSchema, type HistoryPolicy } from './history-settings.ts'
import { historyRecordSchema, historySettingsSchema, type HistoryRecord, type HistoryId, type HistorySettings,
  type HistorySourceSession, type HistoryPage, type HistoryRule, type HistorySourceStatus, type HistoryCard } from './history-schema.ts'
import type { Config } from './config.ts'
import type { WorkJournal, JournalItem } from './journal.ts'

const archiveDomain = defineDomain({ name: 'personal_conversation_archive', version: 1, layout: 'per-record', tables: {
  sessions: domainTable<HistoryId, HistoryRecord>(historyRecordSchema),
  audit: domainTable<string, { events: string }>(z.object({ events: z.string() })),
} })

/**
 * Resolve a local calendar window without using session creation dates.
 * @param lookback - persisted window selection.
 * @param now - local clock, overridable by deterministic tests.
 * @returns inclusive start timestamp.
 */
export function historyWindow(lookback: HistorySettings['lookback'], now = new Date()): number {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (lookback === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  else if (lookback === 'month') {
    const day = start.getDate()
    start.setDate(1)
    start.setMonth(start.getMonth() - 1)
    const last = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()
    start.setDate(Math.min(day, last))
  } else start.setDate(start.getDate() - Number(lookback) + 1)
  return start.getTime()
}

/** One durable archive shared by browser lists and the periodic importer. */
export class ConversationHistory {
  /** Whether source collection or archive analysis is still running. */
  get isRunning(): boolean { return this.running !== null }
  private readonly readers = new HistoryReaders()
  private readonly lifetime = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastScan: string | null = null
  private nextScan: string | null = null
  private error: string | null = null
  private sources: HistorySourceStatus[] = []
  private settings: HistorySettings
  private readonly policy: HistoryPolicy

  private constructor(private readonly ctx: Context, private readonly config: Config, private readonly journal: WorkJournal,
    private readonly domain: Domain<typeof archiveDomain>) {
    this.policy = HistoryPolicySchema(config.history)
    if (this.policy.maxInputChars < this.policy.maxMessageChars * 2) throw new Error('History input limit must fit two message chunks')
    this.settings = { enabled: true, codex: true, cursor: true, intervalMinutes: 60, lookback: 'week',
      model: { provider: config.briefPolish.provider, model: config.briefPolish.model } }
  }

  /**
   * Open retained records; installing settings starts the background schedule.
   * @param ctx - Host storage, settings and LLM services.
   * @param config - deployment policy.
   * @param journal - authoritative task reader.
   * @returns owner requiring awaited disposal.
   */
  static async open(ctx: Context, config: Config, journal: WorkJournal): Promise<ConversationHistory> {
    return new ConversationHistory(ctx, config, journal, await ctx.storageDomain.open(archiveDomain))
  }

  /** Register persisted preferences and start one startup scan after settings are ready. */
  start(): void {
    this.ctx.inject(['settings'], (ctx) => {
      let source = () => this.settings
      ctx.settings.installSection(this.ctx, 'personal-workbench-history', HistoryPreferenceSchema, this.settings, {
        setSource: (current) => { source = current; this.settings = historySettingsSchema.parse(source()); this.schedule() },
        onChange: () => { this.settings = historySettingsSchema.parse(source()); this.schedule() },
      })
      if (this.settings.enabled) this.sync(false)
    })
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.nextScan = null
    if (!this.settings.enabled || this.lifetime.signal.aborted) return
    const ms = this.settings.intervalMinutes * 60_000
    this.nextScan = new Date(Date.now() + ms).toISOString()
    this.timer = setTimeout(() => { this.sync(false) }, ms)
    this.timer.unref()
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Conversation archive is closing'))
    const next = this.queue.then(fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async put(record: HistoryRecord): Promise<void> {
    if (this.policy.maxRecordBytes > 0 && Buffer.byteLength(JSON.stringify(record)) > this.policy.maxRecordBytes) throw new Error(`Conversation archive size limit exceeded: ${record.title}`)
    await this.domain.table('sessions').put(record.id, record)
  }

  private record(id: HistoryId): HistoryRecord {
    const record = this.domain.table('sessions').get(id)
    assert(record, 'Archive records are retained for the lifetime of this owner')
    return record
  }

  private tasks(): JournalItem[] {
    const tasks: JournalItem[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page = this.journal.query({ from: null, to: null, text: '', offset, includeOpen: true })
      tasks.push(...page.items.map(row => row.item)); offset = page.nextOffset
    }
    return tasks.sort((a, b) => Number(['active', 'blocked'].includes(b.status)) - Number(['active', 'blocked'].includes(a.status)))
  }

  private pending(record: HistoryRecord): boolean {
    return !record.ignored && (Boolean(record.initialJob) || record.manualSummaryPending
      || record.messages.some(m => record.analyzed[m.id] !== m.hash))
  }

  /**
   * Read bounded cards without transmitting transcript bodies.
   * @param taskId - task association, null selects the global inbox.
   * @param mode - inbox, all records or ignored conversations.
   * @param offset - page cursor.
   * @param text - title, summary or source identity search across all pages.
   * @param source - optional application filter.
   * @returns current scan health and one card page.
   */
  list(taskId: string | null, mode: 'inbox' | 'all' | 'ignored', offset: number, text = '', source: 'all' | 'codex' | 'cursor' = 'all'): HistoryPage {
    z.number().int().nonnegative().parse(offset)
    if (taskId !== null) z.uuid().parse(taskId)
    z.enum(['inbox', 'all', 'ignored']).parse(mode)
    const needle = z.string().max(500).parse(text).trim().toLocaleLowerCase()
    z.enum(['all', 'codex', 'cursor']).parse(source)
    const records = [...this.domain.table('sessions').entries()].map(([, record]) => record)
    const all = records.filter(r => taskId ? !r.ignored && r.taskIds.includes(taskId)
      : mode === 'ignored' ? r.ignored : !r.ignored && (mode === 'all' || (!r.locked && (!r.taskIds.length || r.analysis?.unclassified)) || !!r.error))
      .filter(r => (source === 'all' || r.source === source) && (!needle
        || [r.title, r.sourceId, r.cwd, r.analysis?.summary, ...(r.analysis?.matches.map(m => m.summary) ?? [])]
          .some(value => value?.toLocaleLowerCase().includes(needle))))
      .sort((a, b) => (b.messages.at(-1)?.at ?? '').localeCompare(a.messages.at(-1)?.at ?? ''))
    const items: HistoryCard[] = all.slice(offset, offset + this.config.pageSize)
      .map(({ messages, analyzed: _analyzed, analysisChunks: _chunks, initialJob, ...r }) => ({
        ...r, fullHistory: Boolean(r.fullHistory),
        firstAt: messages[0]?.at ?? '', lastAt: messages.at(-1)?.at ?? '', messageCount: messages.length,
        pending: this.pending(this.record(r.id)),
        progress: initialJob ? { total: Object.keys(initialJob.targets).length,
          completed: Object.entries(initialJob.targets).filter(([id, hash]) => _analyzed[id] === hash).length } : undefined,
      }))
    return { items, total: all.length, pendingCount: records.filter(r => this.pending(r)).length,
      failedCount: records.filter(r => !r.ignored && r.error).length,
      nextOffset: offset + items.length < all.length ? offset + items.length : null, running: !!this.running,
      lastScan: this.lastScan, nextScan: this.nextScan, sources: this.sources, error: this.error }
  }

  /**
   * Read one retained transcript page without accessing the original app.
   * @param id - retained conversation identity.
   * @param offset - message cursor.
   * @returns metadata and one bounded message page.
   */
  read(id: HistoryId, offset: number): { messages: HistoryRecord['messages']; nextOffset: number | null } {
    z.number().int().nonnegative().parse(offset)
    const record = this.domain.table('sessions').get(historyRecordSchema.shape.id.parse(id))
    if (!record) throw new Error('Archived conversation not found')
    const messages = record.messages.slice(offset, offset + this.config.pageSize)
    return { messages, nextOffset: offset + messages.length < record.messages.length ? offset + messages.length : null }
  }

  /**
   * Lock human associations; moving unchanged associations to/from Trash preserves analysis and assignment policy.
   * @param request - displayed revision and complete manual task set.
   * @returns completion after durable commit; stale edits reject.
   */
  rule(request: HistoryRule): Promise<void> {
    const parsed = z.object({ id: historyRecordSchema.shape.id, revision: z.number().int(),
      taskIds: z.array(z.uuid()).max(30), ignored: z.boolean() }).strict().parse(request)
    return this.serialize(async () => {
      const record = this.domain.table('sessions').get(parsed.id)
      if (!record || record.revision !== parsed.revision) throw new Error('Conversation changed; refresh before editing')
      if (parsed.ignored !== record.ignored && historyHash([...new Set(parsed.taskIds)]) === historyHash(record.taskIds)) {
        await this.put({ ...record, revision: record.revision + 1, ignored: parsed.ignored })
        return
      }
      const tasks = new Set(this.tasks().map(t => String(t.id)))
      if (parsed.taskIds.some(id => !tasks.has(id))) throw new Error('Selected task is unavailable')
      const resetInitial = record.initialJob && historyHash(record.taskIds) !== historyHash([...new Set(parsed.taskIds)])
      await this.put({ ...record,
        ...(resetInitial && record.initialJob
          ? { initialJob: { ...record.initialJob, draft: null }, analyzed: {}, analysisChunks: {} } : {}),
        revision: record.revision + 1, taskIds: [...new Set(parsed.taskIds)],
        ignored: parsed.ignored, locked: parsed.taskIds.length > 0 || parsed.ignored, error: null, failures: 0, retryAt: 0,
        manualSummaryPending: !!record.analysis && !parsed.ignored
          && (record.locked !== (parsed.taskIds.length > 0)
            || historyHash(record.taskIds) !== historyHash([...new Set(parsed.taskIds)])),
      })
    })
  }

  /**
   * Admit one background run; repeated clicks share the current run.
   * @param retry - explicitly reset exhausted failures.
   */
  sync(retry: boolean): void {
    if (this.running || this.lifetime.signal.aborted) return
    this.running = this.run(retry).catch((error: unknown) => { this.error = error instanceof Error ? error.message : String(error) })
      .finally(() => { this.running = null; this.schedule() })
  }

  /** Wait for the currently admitted scan, including result persistence. */
  async idle(): Promise<void> { await this.running }

  private async ingest(session: HistorySourceSession): Promise<void> {
    const entries = session.messages.filter(m => Date.parse(m.at) <= Date.now())
    if (!entries.length && !session.sourceError) return
    await this.serialize(async () => {
      const id = historyId(session)
      const prior = this.domain.table('sessions').get(id)
      const record: HistoryRecord = prior ?? { id, source: session.source, sourceId: session.sourceId, location: session.location,
        title: session.title, cwd: session.cwd, available: true, revision: 0, messages: [], analyzed: {}, analysis: null,
        analyzedAt: null, model: '', taskIds: [], locked: false, ignored: false, error: null, failures: 0, retryAt: 0, manualSummaryPending: false }
      if (session.sourceError) {
        await this.put({ ...record, sourceError: session.sourceError, fullHistory: false, revision: record.revision + 1 })
        return
      }
      const messages = new Map(record.messages.map(m => [m.id, m]))
      const analyzed = new Map(Object.entries(record.analyzed))
      const analysisChunks = new Map(Object.entries(record.analysisChunks ?? {}))
      for (const entry of entries) {
        const previous = messages.get(entry.id)
        if (previous?.truncated && !entry.truncated) {
          if (analyzed.get(entry.id) === entry.hash && entry.text.startsWith(previous.text)) {
            analysisChunks.set(entry.id, { hash: entry.hash, offset: previous.text.length })
          }
          analyzed.delete(entry.id)
        }
        messages.set(entry.id, entry)
      }
      const next = { ...record, analyzed: Object.fromEntries(analyzed), analysisChunks: Object.fromEntries(analysisChunks),
        available: true, title: session.title, cwd: session.cwd,
        messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at)) }
      const completeMessages = next.messages
      const needsInitial = !record.initialComplete && !record.initialJob && !record.fullHistory
        && (!record.analysis || completeMessages.some(m => m.truncated || record.analyzed[m.id] !== m.hash))
      const changedTarget = record.initialJob && completeMessages.some(m =>
        record.initialJob?.targets[m.id] !== undefined && record.initialJob.targets[m.id] !== m.hash)
      const restored = { ...next, sourceError: undefined, fullHistory: !completeMessages.some(m => m.truncated),
        initialComplete: record.initialComplete ?? (!needsInitial && Boolean(record.analysis)) }
      if (needsInitial || changedTarget || (!restored.initialComplete && !record.initialJob)) {
        restored.initialJob = { targets: Object.fromEntries(completeMessages.map(m => [m.id, m.hash])), draft: null }
        restored.analyzed = {}; restored.analysisChunks = {}
        restored.error = null; restored.failures = 0; restored.retryAt = 0
      }
      if (historyHash(record) !== historyHash(restored)) await this.put({ ...restored, revision: record.revision + 1 })
    })
  }

  private async run(retry: boolean): Promise<void> {
    this.error = null
    const settings = structuredClone(this.settings)
    const since = historyWindow(settings.lookback)
    this.sources = []
    for (const source of ['codex', 'cursor'] as const) {
      if (!settings[source]) continue
      const path = source === 'codex' ? this.policy.codexHome : this.policy.cursorStorage
      const health: HistorySourceStatus = { source, path, error: null }
      this.sources.push(health)
      try {
        const tracked = new Set([...this.domain.table('sessions').entries()]
          .filter(([, record]) => record.source === source && record.location === path)
          .map(([, record]) => record.sourceId))
        const sessions = await this.readers[source](path, since, this.policy, this.lifetime.signal, tracked)
        for (const session of sessions) await this.ingest(session)
        // Only a successfully queried store may establish that an original session was deleted.
        for (const [, record] of this.domain.table('sessions').entries()) {
          if (record.source !== source || record.location !== path) continue
          const available = await this.readers.available(source, path, record.sourceId)
          if (available !== record.available) await this.serialize(async () => {
            const current = this.record(record.id)
            await this.put({ ...current, available, revision: current.revision + 1 })
          })
        }
      } catch (error) { health.error = error instanceof Error ? error.message : String(error) }
    }
    const pending = [...this.domain.table('sessions').entries()].map(([id]) => ({ id, retry }))
    for (const work of pending) {
      const { id } = work
      this.lifetime.signal.throwIfAborted()
      let record = this.record(id)
      if (!settings[record.source] || record.ignored || !record.fullHistory) continue
      if (work.retry && record.error) {
        await this.serialize(async () => {
          const current = this.record(id)
          await this.put({ ...current, failures: 0, retryAt: 0, error: null })
        })
        record = this.record(id)
      }
      if (record.failures >= this.policy.maxAttempts || record.retryAt > Date.now()) continue
      if (this.pending(record)) {
        const previousAnalysis = record.initialJob ? record.initialJob.draft : record.analysis
        const delta = record.manualSummaryPending && !record.initialJob ? []
          : record.messages.filter(m => record.analyzed[m.id] !== m.hash
            && (!record.initialJob || record.initialJob.targets[m.id] === m.hash))
        if (!delta.length && !record.manualSummaryPending) continue
        const selected: (typeof delta[number] & { offset: number })[] = []
        const inputBudget = this.policy.maxInputChars - (this.policy.repairAttempts ? this.policy.maxRepairChars : 0)
        const contextBudget = Math.floor(inputBudget / 8)
        const summaryBudget = Math.floor(contextBudget / (1 + (previousAnalysis?.matches.length ?? 0)))
        const previous = previousAnalysis && {
          summary: historyExcerpt(previousAnalysis.summary, summaryBudget), unclassified: previousAnalysis.unclassified,
          matches: previousAnalysis.matches.map(match => ({ taskId: match.taskId,
            summary: historyExcerpt(match.summary, summaryBudget) })) }
        while (previous?.matches.length && JSON.stringify(previous).length > contextBudget) previous.matches.pop()
        const context = record.messages.filter(m => record.analyzed[m.id] === m.hash)
          .slice(-2)
          .map((m) => {
            const text = historyExcerpt(m.text, Math.floor(contextBudget / 2))
            return { ...m, text, truncated: m.truncated || text !== m.text }
          })
        while (context.length && JSON.stringify(context).length > contextBudget) context.shift()
        const taskBudget = Math.floor(inputBudget / 3)
        const base = { previous, locked: record.locked, fixedTaskIds: record.taskIds, context }
        for (const entry of delta) {
          const progress = record.analysisChunks?.[entry.id]
          const offset = progress?.hash === entry.hash ? progress.offset : 0
          const body = entry.text
          let length = Math.min(this.policy.maxMessageChars, body.length - offset)
          const chunk = { ...entry, text: '', offset, truncated: true }
          while (length > 0) {
            chunk.text = body.slice(offset, offset + length)
            chunk.truncated = entry.truncated || offset > 0 || offset + length < entry.text.length
            const size = JSON.stringify({ ...base, tasks: [], omittedTasks: 0, delta: [...selected, chunk] }).length
            if (size <= inputBudget - taskBudget) break
            length = Math.floor(length / 2)
          }
          if (!length) break
          selected.push(chunk)
          if (offset + length < entry.text.length) break
        }
        const { tasks, omittedTasks } = historyTaskInput(this.tasks(),
          selected.length ? selected.map(message => message.text).join('\n') : previousAnalysis?.summary ?? '',
          record.locked ? record.taskIds : [], taskBudget)
        const input = JSON.stringify({ ...base, tasks, omittedTasks, delta: selected })
        try {
          if ((!selected.length && !record.manualSummaryPending)
            || input.length > inputBudget)
            throw new Error('History message metadata exceeds the configured analysis input budget')
          const auditId = randomUUID()
          const taskIds = new Set(tasks.map(t => String(t.id)))
          const evidence = new Set([...selected, ...base.context].map(m => String(m.id)))
          const result = await analyzeHistory(this.ctx, this.config.briefPolish, settings, input,
            events => this.domain.table('audit').put(auditId, { events }), this.lifetime.signal,
            { attempts: this.policy.repairAttempts, maxChars: this.policy.maxRepairChars,
              maxInputChars: this.policy.maxInputChars, validate: (proposal) => {
                if (proposal.matches.some(m => !taskIds.has(m.taskId) || m.evidence.some(id => !evidence.has(id)))
                || new Set(proposal.matches.map(m => m.taskId)).size !== proposal.matches.length)
                  throw new Error('History model returned unknown or duplicate task/evidence references')
              } })
          const grounded = result.matches.filter(m => m.evidence.length > 0)
          if (result.matches.some(m => !m.evidence.length && !previousAnalysis?.matches.some(old => old.taskId === m.taskId)))
            result.unclassified = true
          await this.serialize(async () => {
            const current = this.record(id)
            const liveTasks = new Set(this.tasks().map(t => String(t.id)))
            if (current.ignored || current.revision !== record.revision) return
            const matches = grounded.filter(m => liveTasks.has(m.taskId) && (!current.locked || current.taskIds.includes(m.taskId)))
            // A later topic does not remove earlier task associations supported by retained messages.
            for (const previous of previousAnalysis?.matches ?? []) {
              if (liveTasks.has(previous.taskId) && (!current.locked || current.taskIds.includes(previous.taskId))
                && !matches.some(m => m.taskId === previous.taskId)) matches.push({ ...previous, evidence: [...previous.evidence] })
            }
            for (const match of matches) {
              const previous = previousAnalysis?.matches.find(m => m.taskId === match.taskId)
              match.evidence = [...new Set([...(previous?.evidence ?? []), ...match.evidence])]
            }
            const analyzed = { ...current.analyzed }
            const analysisChunks = new Map(Object.entries(current.analysisChunks ?? {}))
            for (const entry of selected) {
              const original = current.messages.find(m => m.id === entry.id)
              assert(original, 'Selected analysis chunks reference retained messages')
              const offset = entry.offset + entry.text.length
              if (offset >= original.text.length) {
                analyzed[entry.id] = entry.hash
                analysisChunks.delete(entry.id)
              } else analysisChunks.set(entry.id, { hash: entry.hash, offset })
            }
            const complete = !current.initialJob
              || Object.entries(current.initialJob.targets).every(([id, hash]) => analyzed[id] === hash)
            const analysis = { ...result, matches }
            await this.put({ ...current, analyzed, analysisChunks: Object.fromEntries(analysisChunks),
              initialJob: !complete && current.initialJob ? { ...current.initialJob, draft: analysis } : undefined,
              initialComplete: complete, analysis: complete ? analysis : current.analysis,
              taskIds: !complete || current.locked ? current.taskIds : matches.map(m => m.taskId),
              revision: current.revision + 1,
              analyzedAt: complete ? new Date().toISOString() : current.analyzedAt,
              model: complete ? `${settings.model.provider} / ${settings.model.model}` : current.model, error: null, failures: 0, retryAt: 0,
              manualSummaryPending: false })
          })
          const next = this.record(id)
          if (next.ignored
            || historyHash([next.analyzed, next.analysisChunks]) === historyHash([record.analyzed, record.analysisChunks])) continue
          if (this.pending(next)) pending.push({ id, retry: false })
        } catch (error) {
          await this.serialize(async () => {
            const current = this.record(id)
            if (current.ignored || current.revision !== record.revision || this.lifetime.signal.aborted) return
            await this.put({ ...current, error: error instanceof Error ? error.message : String(error), failures: current.failures + 1,
              retryAt: Date.now() + this.policy.retryDelayMs * 2 ** current.failures, revision: current.revision + 1 })
          })
        }
      }
    }
    this.lastScan = new Date().toISOString()
  }

  /** Abort model/read work and await all admitted writes before releasing storage. */
  async close(): Promise<void> {
    clearTimeout(this.timer)
    this.lifetime.abort()
    await this.running
    await this.queue
    await this.domain.close()
  }
}
