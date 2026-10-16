/** Shared week navigation for work planning and personal reflection. */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { localDay, monday, shift } from './journal-calendar.ts'
import css from './JournalToolbar.module.css'

/** Render a page title, week picker, contextual help and native pane actions.
 * @param props - selected Monday and page-owned actions and help.
 * @returns compact journal toolbar.
 */
export function JournalToolbar({ title, week, onWeekChange, help, actions, t }: {
  title: string
  week: string
  onWeekChange: (week: string) => void
  help: ReactNode
  actions?: ReactNode
  t: TranslateNS<'personal-workbench'>
}) {
  return <div className={css.toolbar}>
    <h1>{title}</h1>
    <div className={css.weekControl}>
      <button aria-label={t('journal.previousWeek')} onClick={() => { onWeekChange(shift(week, -7)) }}>‹</button>
      <details className={css.datePicker}>
        <summary aria-label={t('planner.chooseWeek')}>
          {new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            .formatRange(new Date(`${week}T12:00:00`), new Date(`${shift(week, 6)}T12:00:00`))}
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className={css.datePopover}>
          <input type="date" aria-label={t('planner.jumpDate')} value={week} onChange={(e) => {
            if (!e.target.value) return
            onWeekChange(monday(e.target.value))
            e.currentTarget.closest('details')?.removeAttribute('open')
          }} />
        </div>
      </details>
      <button aria-label={t('journal.nextWeek')} onClick={() => { onWeekChange(shift(week, 7)) }}>›</button>
      <button onClick={() => { onWeekChange(monday(localDay())) }}>{t('planner.thisWeek')}</button>
    </div>
    <div className={css.toolbarActions}>
      <details className={css.helpMenu}>
        <summary aria-label={t('planner.help')} title={t('planner.help')}>?</summary>
        <div className={css.helpPopover}>{help}</div>
      </details>
      {actions}
    </div>
  </div>
}
