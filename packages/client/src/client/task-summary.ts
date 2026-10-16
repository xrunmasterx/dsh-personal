/** Read-only card projection; no model requests or independently maintained next-action text. */
import type { JournalItem } from '@xrunmasterx/dsh-personal-host/client'

/**
 * Prefer the saved LLM update, otherwise select one explicit progress record.
 * @param item - current task; missing/empty progress produces no placeholder.
 * @returns plain card text without changing the source document.
 */
export function taskSummary(item: Pick<JournalItem, 'summary' | 'description' | 'status' | 'title'>): string {
  if (item.summary !== undefined) return item.summary
  const lines: string[] = []
  let progress = false
  let fenced = false
  for (const line of (item.description ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const heading = /^##\s+(.+)$/.exec(line.trim())
    if (heading) {
      progress = /^(进展|Progress|How(?: · 如何推进)?)$/i.test(line.trim().replace(/^##\s+/, ''))
      continue
    }
    if (!progress || /^\s*#/.test(line)) continue
    const plain = line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
    if (plain && plain !== item.title) lines.push(plain)
  }
  const next = /^(下一步|Next step)\s*[:：]/i
  const preferred = item.status === 'todo' ? next
    : item.status === 'blocked' ? /^(阻碍|阻塞|等待|卡点|Blocked|Blocker|Waiting)\s*[:：]/i
      : item.status === 'done' ? /^(结果|已完成|已验证|Result|Completed|Verified)\s*[:：]/i
        : /^(已观察|待验证|已确认|Observed|Unverified|Confirmed)\s*[:：]/i
  return lines.find(line => preferred.test(line)) ?? (item.status === 'todo' ? '' : lines[0] ?? '')
}
