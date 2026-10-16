/** Calendar-first activity review using retained evidence and separate human corrections. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { JournalId, ReviewWeek, ReviewEdit, ReviewId, ReviewSource, ReviewSourceId, ReviewActivity } from '@xrunmasterx/dsh-personal-host/client'
import { localDay, monday } from './journal-calendar.ts'
import { JournalToolbar } from './JournalToolbar.tsx'
import { ReviewEvidence } from './ReviewEvidence.tsx'
import { reviewCategories, useReviewView } from './review-view.ts'
import common from './Journal.module.css'
import css from './Retrospective.module.css'

/** Plain callbacks backed by the existing Personal Host. */
export interface ReviewActions {
  read: (day: string) => Promise<ReviewWeek>
  sync: (day: string) => Promise<void>
  edit: (request: ReviewEdit) => Promise<void>
  source: (id: ReviewSourceId) => Promise<ReviewSource>
}
type Copy = TranslateNS<'personal-workbench'>
const labels = (t: Copy) => ({ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') })
const toggled = (ids: string[], id: string) => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]

function Editor({ editor, update, tasks, today, busy, t, save, cancel, error }: {
  editor: ReviewEdit
  update: (edit: ReviewEdit) => void
  tasks: ReviewWeek['tasks']
  today: string
  busy: boolean
  t: Copy
  save: () => void
  cancel: () => void
  error: string
}) {
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => {
    form.current?.querySelector('textarea')?.focus()
  }, [])
  const change = (patch: Partial<ReviewActivity>) => { update({ ...editor, activity: { ...editor.activity, ...patch } }) }
  return <form ref={form} className={css.editor} aria-label={t('review.editor')} onSubmit={(e) => { e.preventDefault(); save() }}>
    <fieldset disabled={busy} className={css.formFields}>
      <div className={css.editorHeading}><strong>{t('review.editor')}</strong><small>{t('review.draftSaved')}</small></div>
      <label>{t('review.content')}<textarea required value={editor.activity.markdown} onChange={(e) => { change({ markdown: e.target.value }) }} /></label>
      <div className={css.editorRow}>
        <label>{t('review.name')}<input placeholder={t('review.autoTitle')} value={editor.activity.title} onChange={(e) => { change({ title: e.target.value }) }} /></label>
        <label>{t('review.date')}<input type="date" required max={today} value={editor.activity.day} onChange={(e) => { change({ day: e.target.value }) }} /></label>
      </div>
      <details><summary>{t('review.associations')}</summary>
        <div className={css.choices} role="group" aria-label={t('review.category')}>
          {reviewCategories.map(tag => <label key={tag}><input type="checkbox" checked={editor.activity.tags.includes(tag)} onChange={() => {
            const tags = editor.activity.tags
            change({ tags: tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag] })
          }} />{t(`review.${tag}`)}</label>)}
        </div>
        <label>{t('review.task')}<select value="" onChange={(e) => { if (e.target.value) change({ taskIds: [...new Set([...editor.activity.taskIds, e.target.value as JournalId])] }) }}>
          <option value="">{t('review.noTask')}</option>{tasks.filter(task => !editor.activity.taskIds.includes(task.id)).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select></label>
        <div className={css.choices}>{editor.activity.taskIds.map(id => <button type="button" key={id} onClick={() => { change({ taskIds: editor.activity.taskIds.filter(task => task !== id) }) }}
          aria-label={t('review.removeTask', { task: tasks.find(task => task.id === id)?.title ?? t('review.unavailableTask') })}>
          {tasks.find(task => task.id === id)?.title ?? t('review.unavailableTask')} ×</button>)}</div>
      </details>
      {error && <p role="alert">{error}</p>}
      <div className={css.editorActions}><button className={common.primary} type="submit" disabled={busy || !editor.activity.markdown.trim()}>{t(busy ? 'review.saving' : 'review.save')}</button>
        <button type="button" disabled={busy} onClick={cancel}>{t('review.cancel')}</button></div>
    </fieldset>
  </form>
}

function Activity({ activity, data, api, t, open, toggle, evidenceOpen, toggleEvidence, disabled, edit, hide, editor }: {
  activity: ReviewActivity
  data: ReviewWeek
  api: ReviewActions
  t: Copy
  open: boolean
  toggle: () => void
  evidenceOpen: boolean
  toggleEvidence: () => void
  disabled: boolean
  edit?: () => void
  hide?: () => void
  editor?: ReactNode
}) {
  const sources = data.sources.filter(s => activity.evidence.includes(s.id))
  return <article className={css.card} aria-label={activity.title}>
    <div className={css.cardHead}><button className={css.title} aria-expanded={open} onClick={toggle}>
      <span aria-hidden="true">{open ? '⌄' : '›'}</span>{activity.title}</button>
    {edit && <button disabled={disabled} onClick={edit}>{t('review.edit')}</button>}{hide && <button disabled={disabled} onClick={hide}>{t('review.hide')}</button>}
    </div>
    <div className={css.meta}>{activity.tags.map(tag => <span key={tag}>{t(`review.${tag}`)}</span>)}
      {activity.taskIds.slice(0, open ? activity.taskIds.length : 2).map(id =>
        <span key={id}>{data.tasks.find(task => task.id === id)?.title ?? t('review.unavailableTask')}</span>)}
      {!open && activity.taskIds.length > 2 && <span>{t('review.moreTasks', { count: activity.taskIds.length - 2 })}</span>}
      {data.corrections.some(c => c.id === activity.id) && <span>{t('review.manual')}</span>}
    </div>
    {editor ?? <div className={open ? css.body : css.preview}>
      <MarkdownText text={open ? activity.markdown : activity.markdown.split(/\n\s*\n/)[0] ?? ''} labels={labels(t)} />
    </div>}
    {!!activity.evidence.length && <button className={css.evidenceToggle} aria-expanded={evidenceOpen} onClick={toggleEvidence}>{t('review.sources', { count: activity.evidence.length })}</button>}
    {evidenceOpen && <ReviewEvidence sources={sources} api={api} t={t} zone={data.timeZone} />}
  </article>
}

/** Daily cards, cross-day weekly synthesis and preserved legacy reports.
 * @param props Host callbacks, locale and original weekly-report reader.
 * @returns Calendar-first review page; drafts and reading choices survive tab reloads without switching Agent sessions.
 */
export function Retrospective({ api, t, pollIntervalMs, actions, legacy }: {
  api: ReviewActions
  t: Copy
  pollIntervalMs: number
  actions?: ReactNode
  legacy: (week: string) => ReactNode
}) {
  const { view, update, storageFailed } = useReviewView()
  const { day, mode, editor } = view
  const [data, setData] = useState<ReviewWeek | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [readError, setReadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [undo, setUndo] = useState<ReviewEdit | null>(null)
  const week = monday(day)
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>
    setData(previous => previous?.from === week ? previous : null)
    const load = async () => {
      try { const value = await api.read(week); if (active) { setData(value); setReadError('') } }
      catch (e) { if (active) setReadError(String(e)) }
      finally { if (active) timer = setTimeout(() => { void load() }, pollIntervalMs) }
    }
    void load()
    return () => { active = false; clearTimeout(timer) }
  }, [api, week, reload, pollIntervalMs])
  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await fn(); setReload(value => value + 1) } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const correction = (activity: ReviewActivity, hidden = false): ReviewEdit => ({ id: activity.id,
    expectedRevision: data?.corrections.find(c => c.id === activity.id)?.revision ?? 0, activity, hidden })
  const selected = data?.days.find(d => d.day === day)
  const hidden = data?.corrections.filter(c => c.hidden && c.activity.day === day) ?? []
  const cards = mode === 'week' ? data?.weekly?.activities ?? [] : selected?.activities ?? []
  const query = view.query.trim().toLocaleLowerCase()
  const filtered = cards.filter(a => (!view.category || a.tags.some(tag => tag === view.category)) && (!query ||
    [a.title, a.markdown, ...a.taskIds.map(id => data?.tasks.find(task => task.id === id)?.title ?? '')].join(' ').toLocaleLowerCase().includes(query)))
  const failure = mode === 'week' ? data?.weekly?.error : selected?.error
  const updatedAt = mode === 'week' ? data?.weekly?.updatedAt : selected?.updatedAt
  const editorVisible = mode === 'day' && !!editor && view.editorDay === day
  const editorCard = editor && cards.some(a => a.id === editor.id)
  const jump = (date: string) => { update({ day: date }); setError(''); setNotice(''); setUndo(null) }
  const showEditor = (edit: ReviewEdit) => { update({ editor: edit, editorDay: day, query: '', category: '' }); setError(''); setNotice('') }
  const save = () => { if (editor) void run(async () => {
    const title = editor.activity.title.trim() || editor.activity.markdown.trim().replace(/\r?\n[\s\S]*/, '').slice(0, 100)
    await api.edit({ ...editor, activity: { ...editor.activity, title } })
    update({ editor: null, day: editor.activity.day, query: '', category: '' }); setNotice(t('review.saved'))
  }) }
  const form = editor && <Editor key={editor.id} editor={editor} update={(edit) => { update({ editor: edit }) }} tasks={data?.tasks ?? []}
    today={data?.today ?? localDay()} busy={busy} t={t} error={error} save={save} cancel={() => { update({ editor: null }); setError('') }} />
  return <div className={`${common.journal} ${css.review}`}>
    <JournalToolbar title={t('review.title')} week={week} onWeekChange={(date) => { jump(date === monday(data?.today ?? localDay()) ? data?.today ?? localDay() : date) }} t={t} actions={actions} help={<p>{t('review.help')}</p>} />
    <div className={css.toolbar}>
      <div className={css.tabs}>{(['day', 'week', 'legacy'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { update({ mode: value }); setError('') }}>{t(`review.${value}`)}</button>)}</div>
      {mode !== 'legacy' && <button disabled={busy || !data} onClick={() => { void run(async () => { await api.sync(day); setNotice(t('review.queued')) }) }}>{t('review.update')}</button>}
      {mode === 'day' && <button disabled={busy || !!editor || !data || day > data.today} onClick={() => {
        const id = randomUUID() as ReviewId
        showEditor({ id, expectedRevision: 0, hidden: false, activity: { id, day, title: '', markdown: '', tags: [], taskIds: [], evidence: [] } })
      }}>{t('review.add')}</button>}
    </div>
    {readError && <p role="alert">{readError} <button onClick={() => { setReload(n => n + 1) }}>{t('review.retry')}</button></p>}
    {error && !editorVisible && <p role="alert">{error}</p>}
    {storageFailed && <p role="alert">{t('task.storageFailed')}</p>}
    {notice && <div className={css.receipt} role="status">{notice}{undo && <button disabled={busy} onClick={() => { void run(async () => { await api.edit(undo); setUndo(null); setNotice(t('review.restored')) }) }}>{t('review.undo')}</button>}</div>}
    {editor && !editorVisible && <div className={css.receipt}>{t('review.draftAt', { day: editor.activity.day })}<button onClick={() => { update({ mode: 'day', day: view.editorDay, query: '', category: '' }) }}>{t('review.continueDraft')}</button></div>}
    {mode === 'legacy' ? legacy(week) : <>
      {!!data?.sourceErrors.length && <details className={css.coverage}><summary>{t('review.coverageWarning', { count: data.sourceErrors.length })}</summary>
        <p>{t('review.coverageHelp')}</p>{data.sourceErrors.map(message => <p key={message}>{message}</p>)}
      </details>}
      {mode === 'day' && <div className={css.days} aria-label={t('review.dates')}>{data?.days.map(d => <button key={d.day} aria-pressed={day === d.day} aria-current={d.day === data.today ? 'date' : undefined}
        aria-label={`${d.day} · ${t(d.day === data.today ? 'review.today' : 'review.day')} · ${t('review.activities', { count: d.activities.length })}`} onClick={() => { jump(d.day) }}>
        <small>{d.day === data.today ? t('review.today') : new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}</small>
        <strong>{d.day.slice(5)}</strong><span>{d.error ? t('review.failed') : d.day > data.today ? '—' : d.activities.length ? t('review.activities', { count: d.activities.length }) : '—'}</span>
      </button>)}</div>}
      <div className={css.statusLine} aria-live="polite"><strong>{mode === 'day' ? day : t('review.week')}</strong>
        {data?.running ? <small>{t('review.running')}</small> : updatedAt && <small>{t('review.updated', { time: new Date(updatedAt).toLocaleString() })}</small>}
      </div>
      {mode === 'week' && data?.weeklyStale && <p role="status">{t('review.staleWeek')}</p>}
      {failure && <p role="alert">{t(updatedAt ? 'review.error' : 'review.firstError', { message: failure })}</p>}
      {(cards.length > 0 || view.query || view.category) && <div className={css.filters}>
        <input type="search" aria-label={t('review.search')} placeholder={t('review.search')} value={view.query} onChange={(e) => { update({ query: e.target.value }) }} />
        <select aria-label={t('review.category')} value={view.category} onChange={(e) => { update({ category: e.target.value }) }}><option value="">{t('review.allCategories')}</option>
          {reviewCategories.map(tag => <option key={tag} value={tag}>{t(`review.${tag}`)}</option>)}</select>
        {(view.query || view.category) && <button onClick={() => { update({ query: '', category: '' }) }}>{t('review.clearFilters')}</button>}
      </div>}
      {editorVisible && (!editorCard || !filtered.some(a => a.id === editor.id)) && form}
      {!data ? !readError && <p>{t('review.loading')}</p> : !filtered.length && !editorVisible && <p className={css.empty}>{t(cards.length ? 'review.noMatches' : failure ? 'review.noPublished' : mode === 'day' && day > data.today ? 'review.future' : data.running ? 'review.collecting' : mode === 'week' ? 'review.noWeek' : 'review.empty')}</p>}
      <div className={css.cards}>{data && filtered.map(activity => <Activity
        key={activity.id} activity={activity} data={data} api={api} t={t}
        open={view.expanded.includes(activity.id)} toggle={() => { update({ expanded: toggled(view.expanded, activity.id) }) }}
        evidenceOpen={view.evidence.includes(activity.id)}
        toggleEvidence={() => { update({ evidence: toggled(view.evidence, activity.id) }) }}
        disabled={busy || !!editor} editor={editorVisible && editor.id === activity.id ? form : undefined}
        {...(mode === 'day' ? { edit: () => { showEditor(correction(activity)) }, hide: () => { void run(async () => {
          const request = correction(activity, true); await api.edit(request)
          setUndo({ ...request, hidden: false, expectedRevision: request.expectedRevision + 1 }); setNotice(t('review.hiddenNotice', { title: activity.title }))
        }) } } : {})} />)}</div>
      {mode === 'day' && !!hidden.length && <details className={css.coverage}><summary>{t('review.hidden', { count: hidden.length })}</summary>
        {hidden.map(c => <div key={c.id} className={css.toolbar}><span>{c.activity.title}</span>
          <button disabled={busy} onClick={() => { void run(async () => {
            await api.edit({ ...c, expectedRevision: c.revision, hidden: false }); setUndo(null); setNotice(t('review.restored'))
          }) }}>{t('review.restore')}</button></div>)}
      </details>}
    </>}
  </div>
}
