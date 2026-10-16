/** Shared dates and semantic badges for source tickets and investigation history. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TapdTodoItem, RunSummary } from '@xrunmasterx/dsh-personal-api/client'
import clsx from 'clsx'
import css from './Workbench.module.css'
type Copy = TranslateNS<'personal-workbench'>
type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'violet'

/** Format a provider timestamp, or the localized unknown value.
 * @param value Provider timestamp, or an absent date.
 * @param t Workbench locale.
 * @returns Local date and time or unknown copy.
 */
export function date(value: string | number | null | undefined, t: Copy): string {
  return value ? new Date(value).toLocaleString() : t('unknown')
}
/** Render a semantic badge without changing the enclosing surface.
 * @param props Label, activity flag and semantic color.
 * @returns Inline status label.
 */
export function Badge({ children, active = false, tone = 'neutral' }: { children: string; active?: boolean; tone?: Tone }) {
  return <span className={clsx(css.badge, active && css.activeBadge)} data-tone={tone}>{children}</span>
}

/** Map a TAPD category to its semantic color.
 * @param kind TAPD work-item category.
 * @returns Badge color token.
 */
export function kindTone(kind: TapdTodoItem['kind']): Tone {
  return kind === 'bug' ? 'danger' : kind === 'story' ? 'info' : 'success'
}

/** Map provider priority labels to their semantic color.
 * @param priority Optional provider priority label.
 * @returns Recognized priority color or neutral.
 */
export function priorityTone(priority: string | undefined): Tone {
  const value = priority?.toLowerCase() ?? ''
  if (/(紧急|最高|high|urgent|p0|p1)/.test(value)) return 'danger'
  if (/(高|中|medium|p2)/.test(value)) return 'warning'
  return 'neutral'
}

/** Map provider status labels to their semantic color.
 * @param status Provider status label.
 * @returns Recognized lifecycle color or neutral.
 */
export function statusTone(status: string): Tone {
  const value = status.toLowerCase()
  if (/(完成|关闭|已处理|resolved|closed|done|completed)/.test(value)) return 'success'
  if (/(拒绝|驳回|失败|reject|failed)/.test(value)) return 'danger'
  if (/(处理中|实现中|进行中|接受|progress|working)/.test(value)) return 'warning'
  if (/(新|待|规划|open|new|pending|plan)/.test(value)) return 'info'
  return 'neutral'
}

/** Map investigation lifecycle state to its semantic color.
 * @param status Investigation lifecycle state.
 * @returns Badge color token.
 */
export function runTone(status: RunSummary['status']): Tone {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'interrupted') return 'danger'
  if (status === 'running' || status === 'queued' || status === 'stopping') return 'warning'
  return 'neutral'
}
