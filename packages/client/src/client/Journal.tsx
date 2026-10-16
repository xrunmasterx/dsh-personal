/** Daily retrospectives and retained weekly reports beside the work board. */
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { useEffect, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { JournalEvent, JournalId } from '@xrunmasterx/dsh-personal-host/client'
import { JournalReceipt as Receipt } from './JournalDetails.tsx'
import type { JournalActions } from './journal-api.ts'
import { localDay, shift, monday } from './journal-calendar.ts'
import { JournalToolbar } from './JournalToolbar.tsx'
import { Planner } from './Planner.tsx'
import { Retrospective } from './Retrospective.tsx'
import css from './Journal.module.css'
export type { JournalActions } from './journal-api.ts'

function identity(): JournalId {
  return randomUUID() as JournalId
}
/** Route the unified work board and saved weekly reflection.
 * @param props - shared Host callbacks.
 * @returns selected journal view.
 */
export function Journal(props: {
  page: 'board' | 'reflection'
  boardActions?: ReactNode
  archivedSessionIds: WorkspaceSnapshot['archivedSessionIds']
  sessions: SessionListState
  onTaskDetail: (open: boolean) => void
  api: JournalActions
  t: TranslateNS<'personal-workbench'>
  pollIntervalMs: number
}) {
  return props.page === 'board' ? <Planner {...props} /> : props.api.reviews
    ? <Retrospective api={props.api.reviews} t={props.t} pollIntervalMs={props.pollIntervalMs}
        actions={props.boardActions} legacy={week => <Reflection {...props} selectedWeek={week} />} />
    : <Reflection {...props} />
}
function Reflection({
  boardActions,
  api,
  t,
  pollIntervalMs,
  selectedWeek,
}: {
  boardActions?: ReactNode
  api: JournalActions
  t: TranslateNS<'personal-workbench'>
  pollIntervalMs: number
  selectedWeek?: string
}) {
  const [selectedDay, setDay] = useState(localDay)
  const week = selectedWeek ?? monday(selectedDay)
  const [report, setReport] = useState<Awaited<ReturnType<JournalActions['journalReport']>> | null>(null)
  const [editReport, setEditReport] = useState<{
    text: string
    source: NonNullable<NonNullable<typeof report>['report']>
  } | null>(null)
  const [sources, setSources] = useState<Record<string, JournalEvent>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const changed = () => {
    setReload(n => n + 1)
    setNotice(t('journal.saved'))
  }
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const value = await api.journalReport(week)
        if (!stopped) setReport(value)
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!stopped) timer = setTimeout(() => void load(), pollIntervalMs)
      }
    }
    setReport(null)
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [api, week, pollIntervalMs, reload])
  const selectDay = (day: string) => {
    if (day) {
      setDay(day)
      setEditReport(null)
    }
  }
  const savedReport = report?.report
  return (
    <div className={css.journal}>
      {!selectedWeek && <JournalToolbar title={t('nav.reflection')} week={week} onWeekChange={selectDay} t={t}
        help={<p>{t('journal.reflectionHelp')}</p>} actions={boardActions} />}
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={css.notice}>
          {notice}
        </p>
      )}
      <fieldset disabled={busy} className={`${css.body} ${css.reflectionBody}`}>
        <section className={css.reflection}>
          <div className={css.line}>
            <h2>
              {week} — {shift(week, 6)}
            </h2>
            <button
              className={css.primary}
              onClick={() =>
                void run(async () => {
                  await api.assist(t('journal.weekPrompt', { day: selectedWeek ?? selectedDay }))
                  setNotice(t('journal.agentSent'))
                })
              }
            >
              {t(report?.report ? 'journal.regenerate' : 'journal.generate')}
            </button>
          </div>
          {report?.stale && <p className={css.warning}>{t('journal.stale')}</p>}
          {savedReport ? (
            <>
              <small>
                {t('journal.version', { version: savedReport.version })} ·{' '}
                {new Date(savedReport.at).toLocaleString()}
              </small>
              <div className={css.markdown}>
                <MarkdownText
                  text={savedReport.markdown}
                  labels={{
                    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
                    footnotes: t('footnotes'),
                  }}
                />
              </div>
              <div className={css.actions}>
                <button
                  onClick={() => {
                    setEditReport({ text: savedReport.markdown, source: savedReport })
                  }}
                >
                  {t('journal.editReflection')}
                </button>
                <button
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(savedReport.markdown)
                      setNotice(t('journal.copied'))
                    })
                  }
                >
                  {t('journal.copy')}
                </button>
              </div>
              {editReport && (
                <div className={css.editor}>
                  <textarea
                    aria-label={t('journal.editReflection')}
                    value={editReport.text}
                    onChange={(e) => {
                      setEditReport({ ...editReport, text: e.target.value })
                    }}
                    maxLength={20000}
                  />
                  <div className={css.actions}>
                    <button
                      onClick={() =>
                        void run(async () => {
                          await api.journalSaveReport({
                            kind: 'edit',
                            id: identity(),
                            from: editReport.source.from,
                            fingerprint: editReport.source.fingerprint,
                            markdown: editReport.text,
                            references: editReport.source.references,
                            expectedReportId: editReport.source.id,
                          })
                          setEditReport(null)
                          changed()
                        })
                      }
                    >
                      {t('journal.saveReflection')}
                    </button>
                    <button
                      onClick={() => {
                        setEditReport(null)
                      }}
                    >
                      {t('journal.cancel')}
                    </button>
                  </div>
                </div>
              )}
              <h3>{t('journal.references')}</h3>
              {savedReport.references.map((id, index) => (
                <details
                  key={id}
                  onToggle={(e) => {
                    if (e.currentTarget.open && !sources[id])
                      void run(async () => {
                        const entry = await api.journalEvent(id)
                        setSources(previous => ({ ...previous, [id]: entry }))
                      })
                  }}
                >
                  <summary>
                    {t('journal.references')} {index + 1}
                  </summary>
                  {sources[id] && <Receipt entry={sources[id]} t={t} />}
                </details>
              ))}
            </>
          ) : (
            <p className={css.empty}>{t('journal.noReflection')}</p>
          )}
        </section>
      </fieldset>
    </div>
  )
}
