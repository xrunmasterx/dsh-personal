/** Local archive reads for calendar retrospectives; no new upstream collection. */
import { createHash } from 'node:crypto'
import type { ConversationHistory } from './history.ts'
import type { CodeHistory } from './code-history.ts'
import type { WorkJournal, JournalId } from './journal.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { reviewSourceIdSchema, type ReviewSource } from './review-schema.ts'

/** Stable content fingerprint.
 * @param value JSON data.
 * @returns SHA-256 hex.
 */
export function reviewHash(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
  return createHash('sha256').update(text).digest('hex')
}
/** Calendar date in the configured zone.
 * @param at Instant.
 * @param timeZone IANA zone.
 * @returns ISO date.
 */
export function reviewDay(at: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-')
}
/** Shift calendar days independently of DST.
 * @param day ISO date.
 * @param count Days.
 * @returns ISO date.
 */
export function reviewShift(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10)
}
/** Week anchor.
 * @param day ISO date.
 * @returns Monday date.
 */
export function reviewMonday(day: string): string { return reviewShift(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7)) }
/** Frozen source read used by one review run. */
export interface ReviewInputs { sources: ReviewSource[]; errors: string[]; tasks: { id: JournalId; title: string }[] }

/** Read retained evidence and source health, without interpreting current task state as daily work.
 * @param history Conversation archive.
 * @param code Commit archive.
 * @param journal Dated task receipts.
 * @param from Inclusive date.
 * @param to Inclusive date.
 * @param zone Calendar timezone.
 * @returns Source messages, actual receipts, commit observations and task labels.
 */
export function reviewInputs(history: Pick<ConversationHistory, 'list' | 'read'>, code: Pick<CodeHistory, 'list'>, journal: Pick<WorkJournal, 'query' | 'activity'>,
  from: string, to: string, zone: string): ReviewInputs {
  const sources: ReviewSource[] = []; const errors = new Set<string>(); const tasks: ReviewInputs['tasks'] = []
  const add = (key: string, source: Omit<ReviewSource, 'id'>) => {
    if (source.day >= from && source.day <= to) sources.push({ ...source, id: reviewSourceIdSchema.parse(reviewHash([key, source])) })
  }
  let offset: number | null = 0
  while (offset !== null) {
    const page = journal.query({ from: null, to: null, text: '', offset, includeOpen: true })
    tasks.push(...page.items.map(r => ({ id: r.item.id, title: r.item.title }))); offset = page.nextOffset
  }
  offset = 0
  while (offset !== null) {
    const page = history.list(null, 'all', offset)
    if (!page.lastScan) errors.add('对话归档尚未完成首次扫描')
    if (page.error) errors.add(page.error)
    for (const status of page.sources) if (status.error) errors.add(`${status.source}: ${status.error}`)
    for (const card of page.items) {
      if (card.sourceError) errors.add(`${card.title}: ${card.sourceError}`)
      if (!card.fullHistory) errors.add(`${card.title}: 历史仍在采集`)
      if (!card.firstAt || !card.lastAt) continue
      if (reviewDay(card.lastAt, zone) < from || reviewDay(card.firstAt, zone) > to) continue
      let cursor: number | null = 0
      while (cursor !== null) {
        const messages = history.read(card.id, cursor)
        for (const m of messages.messages) add(`${card.id}:${m.id}`, {
          day: reviewDay(m.at, zone), at: m.at, kind: card.source, label: card.title, text: m.text,
          role: `${m.role}${m.phase ? `/${m.phase}` : ''}`, taskIds: card.taskIds.map(id => brandString<JournalId>(id)),
        })
        cursor = messages.nextOffset
      }
    }
    offset = page.nextOffset
  }
  offset = 0
  while (offset !== null) {
    const page = journal.activity(from, to, offset)
    for (const event of page.events) {
      if (page.revertedIds.includes(event.id) || event.reverts || !event.after) continue
      const transition = event.before && event.before.status !== event.after.status
      if (!event.log && !transition) continue
      add(event.id, { day: event.log?.day ?? event.day, at: event.at, kind: 'journal', label: event.after.title,
        text: JSON.stringify({ operation: event.operation, reason: event.reason, recordedAt: event.at, progress: event.log?.text,
          statusChange: transition ? { from: event.before?.status, to: event.after.status } : null }),
        role: 'recorded-user-change', taskIds: [event.itemId],
      })
    }
    offset = page.nextOffset
  }
  offset = 0
  while (offset !== null) {
    const page = code.list(null, null, offset)
    if (page.error) errors.add(page.error)
    for (const group of page.items) {
      for (const commit of group.commits) add(commit.id, {
        day: reviewDay(commit.committedAt, zone), at: commit.committedAt, kind: 'code', label: commit.title,
        text: JSON.stringify({ event: commit.equivalentTo ? 'equivalent-commit' : 'commit', changeId: group.id,
          equivalentTo: commit.equivalentTo, message: commit.message, analysis: commit.analysis?.summary ?? null }),
        role: 'commit-evidence', taskIds: commit.analysis?.matches.map(m => brandString<JournalId>(m.taskId)) ?? [], url: commit.url,
      })
      for (const event of group.stageEvents) add(`${group.id}:${event.stage}`, {
        day: reviewDay(event.observedAt, zone), at: event.observedAt, kind: 'code', label: group.title,
        text: JSON.stringify({ event: 'stage-observed', stage: event.stage, observedAt: event.observedAt, note: 'Observation time, not exact merge time or test success' }),
        role: 'branch-observation', taskIds: group.analysis?.matches.map(m => brandString<JournalId>(m.taskId)) ?? [], url: group.url,
      })
    }
    offset = page.nextOffset
  }
  return { sources: sources.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), errors: [...errors], tasks }
}
