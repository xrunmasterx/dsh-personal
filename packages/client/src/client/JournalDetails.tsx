/** Immutable journal receipts for retrospective evidence inspection. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { JournalEvent } from '@xrunmasterx/dsh-personal-host/client'
import css from './Journal.module.css'

type Copy = TranslateNS<'personal-workbench'>

/** Render an immutable work receipt, including original plans and undo markers.
 * @param props - receipt and localized copy.
 * @returns source evidence.
 */
export function JournalReceipt({
  entry,
  t,
  reverted = false,
}: {
  entry: JournalEvent
  t: Copy
  reverted?: boolean
}) {
  return (
    <article id={`journal-event-${entry.id}`} className={css.receipt} data-reverted={reverted}>
      <div className={css.line}>
        <strong>{entry.after?.title ?? entry.before?.title}</strong>
        <span>{t(`journal.change.${entry.operation}`)}</span>
      </div>
      <p>{entry.log?.text ?? entry.reason}</p>
      {entry.before?.plans
        .filter(
          p =>
            !entry.after?.plans.some(
              current =>
                current.day === p.day &&
                current.intention === p.intention &&
                current.start === p.start &&
                current.end === p.end,
            ),
        )
        .map(p => (
          <p key={p.day}>
            {t('journal.beforePlan')} · {p.day} {p.start && `${p.start}–${p.end}`} {p.intention}
          </p>
        ))}
      {entry.after && entry.before?.status !== entry.after.status && (
        <small>
          {t('journal.status')} · {t(`journal.${entry.after.status}`)}
        </small>
      )}
      {entry.log?.minutes !== null && entry.log?.minutes !== undefined && (
        <small>
          {t('journal.minutes')} · {entry.log.minutes}
        </small>
      )}
      {entry.operation === 'plan' &&
        entry.after?.plans.map(p => (
          <p key={p.day}>
            {p.day} {p.start} {p.intention}
          </p>
        ))}
      {entry.after?.nextAction && (
        <p>
          {t('journal.nextAction')} · {entry.after.nextAction}
        </p>
      )}
      <small>
        {entry.day} · {t('journal.recordedAt')} {new Date(entry.at).toLocaleString()}{' '}
        {reverted ? ` · ${t('journal.reverted')}` : ''}
      </small>
    </article>
  )
}
