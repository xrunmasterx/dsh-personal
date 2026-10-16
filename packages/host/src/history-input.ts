/** Bounded task context for archive matching; stored task descriptions remain unchanged. */
import type { JournalItem } from './journal.ts'
import { redactHistory } from './history-redaction.ts'
import assert from 'node:assert/strict'

type TaskInput = { id: JournalItem['id']; title: string; status: JournalItem['status']; description?: string }

/** Fit an excerpt including its omission marker inside a serialized JSON string budget.
 * @param text Original context text.
 * @param budget Maximum JSON string characters, including quotes and escapes.
 * @returns Head and tail excerpt, or empty text when no content fits.
 */
export function historyExcerpt(text: string, budget: number): string {
  if (JSON.stringify(text).length <= budget) return text
  let low = 0; let high = text.length
  let result = ''
  while (low <= high) {
    const length = Math.floor((low + high) / 2)
    const head = Math.ceil(length / 2); const tail = Math.floor(length / 2)
    const candidate = text.slice(0, head) + '\n[…]\n' + (tail ? text.slice(-tail) : '')
    if (JSON.stringify(candidate).length <= budget) { result = candidate; low = length + 1 }
    else high = length - 1
  }
  return result
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
function words(text: string): Set<string> {
  return new Set([...segmenter.segment(text.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment))
}
function score(text: string, terms: Set<string>): number {
  return [...words(text)].filter(term => terms.has(term)).length
}

/** Supply compact task identities and bounded relevant description excerpts.
 * @param items Current tasks, in the owner's stable priority order.
 * @param query Selected message batch used only for candidate ranking.
 * @param preferred User-fixed task IDs; automatic matches have no ranking priority.
 * @param budget Maximum serialized task array characters.
 * @returns Candidate index and count omitted when even compact identities cannot all fit.
 */
export function historyTaskInput(items: JournalItem[], query: string, preferred: readonly string[], budget: number): {
  tasks: TaskInput[]
  omittedTasks: number
} {
  const terms = words(query)
  const ranked = items.map((item) => {
    const title = redactHistory(item.title)
    const description = redactHistory(item.description ?? item.nextAction)
    const paragraphs = description.split(/\n\s*\n/)
      .map((text, order) => ({ text, order, relevance: score(text, terms) }))
      .sort((a, b) => b.relevance - a.relevance || a.order - b.order)
    return { item, title, description: paragraphs.map(p => p.text).join('\n\n'),
      preferred: preferred.includes(item.id), relevance: score(title, terms) * 2 + score(description, terms) }
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.relevance - a.relevance)
  const tasks: TaskInput[] = []
  // Identities get priority over details. Oversized titles cannot exclude other candidates.
  const titleBudget = Math.max(2, Math.floor(budget / 2 / Math.max(1, items.length)))
  for (const candidate of ranked) {
    const task = { id: candidate.item.id, title: historyExcerpt(candidate.title, titleBudget), status: candidate.item.status }
    if (JSON.stringify([...tasks, task]).length > budget) break
    tasks.push(task)
  }
  const candidates = ranked.slice(0, tasks.length).filter(t => t.preferred || t.relevance > 0)
  let remaining = budget - JSON.stringify(tasks).length
  for (const [index, candidate] of candidates.entries()) {
    const task = tasks.find(t => t.id === candidate.item.id)
    assert(task, 'Description candidates belong to the selected task index')
    const allowance = Math.floor(remaining / (candidates.length - index))
    const description = historyExcerpt(candidate.description, allowance - ',"description":'.length)
    if (!description) continue
    const before = JSON.stringify(task).length
    task.description = description
    remaining -= JSON.stringify(task).length - before
  }
  return { tasks, omittedTasks: items.length - tasks.length }
}
