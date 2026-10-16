/** External conversation inbox and read-only task histories inside the Personal work area. */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HistoryId, HistoryCard, HistoryPage, HistoryMessage, HistoryRule, JournalItem, JournalQuery, JournalPage } from '@xrunmasterx/dsh-personal-host/client'
import css from './History.module.css'

/** Archive actions injected by the Personal host bridge. */
export interface HistoryActions {
  list: (taskId: string | null, mode: 'inbox' | 'all' | 'ignored', offset: number, text?: string, source?: 'all' | 'codex' | 'cursor') => Promise<HistoryPage>
  read: (id: HistoryId, offset: number) => Promise<{ messages: HistoryMessage[]; nextOffset: number | null }>
  sync: (retry: boolean) => Promise<void>
  rule: (request: HistoryRule) => Promise<void>
  tasks: (query: JournalQuery) => Promise<JournalPage>
}
/** Left work-area mount for task transcript reading layers. */
export const HistoryReadingHost = createContext<HTMLElement | null>(null)

type Copy = TranslateNS<'personal-workbench'>

function AnalysisStatus({ card, t }: { card: HistoryCard; t: Copy }) {
  return <>
    {card.fullHistory === false && <span title={card.sourceError}>{t('history.incomplete')}</span>}
    {card.progress && <span>{t('history.initialProgress', card.progress)}</span>}
    {!card.progress && card.pending && <span>{t(card.initialComplete ? 'history.updating' : 'history.pending')}</span>}
    {card.error && <span>{t('history.progressRetained')}</span>}
  </>
}

function Assignment({ card, api, t, done, cancel }: {
  card: HistoryCard
  api: HistoryActions
  t: Copy
  done: () => void
  cancel: () => void
}) {
  const [tasks, setTasks] = useState<JournalItem[]>([])
  const [ids, setIds] = useState(card.taskIds)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const active = { current: true }
    void (async () => {
      const items: JournalItem[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const page = await api.tasks({ from: null, to: null, text: '', includeOpen: true, offset })
        items.push(...page.items.map(row => row.item)); offset = page.nextOffset
      }
      if (!active.current) return
      setTasks(items); setLoaded(true)
    })().catch((error: unknown) => { if (active.current) setError(String(error)) })
      .finally(() => { if (active.current) setLoading(false) })
    return () => { active.current = false }
  }, [api])
  return <section className={css.card} aria-label={t('history.tasks')}>
    <h3>{t('history.tasks')} · {card.title}</h3>
    <p className={css.meta}>{t('history.assignmentHint')}</p>
    <input type="search" value={query} aria-label={t('history.searchTasks')} placeholder={t('history.searchTasks')}
      onChange={(event) => { setQuery(event.target.value) }} />
    {loading && <p role="status">{t('history.loading')}</p>}
    {!loading && !tasks.length && <p>{t('history.noTasks')}</p>}
    <div className={css.choices}>{tasks.filter(task => task.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      .map(task => <label key={task.id}>
        <input type="checkbox" disabled={busy} checked={ids.includes(task.id)} onChange={(event) =>{  setIds(event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id)) }} />{task.title}
      </label>)}</div>
    {error && <p role="alert" className={css.error}>{error}</p>}
    <div className={css.toolbar}><button disabled={busy || !loaded} onClick={() => {
      setBusy(true); setError('')
      void api.rule({ id: card.id, revision: card.revision, taskIds: ids, ignored: false }).then(done, (error: unknown) => {
        setError(String(error))
      }).finally(() => { setBusy(false) })
    }}>{t('history.save')}</button><button disabled={busy} onClick={cancel}>{t('history.cancel')}</button></div>
  </section>
}

function Transcript({ card, api, t, back, taskId }: {
  card: HistoryCard
  api: HistoryActions
  t: Copy
  back: () => void
  taskId: string | null
}) {
  const [messages, setMessages] = useState<HistoryMessage[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(true)
  const [focused, setFocused] = useState<{ id: string } | null>(null)
  const messageNodes = useRef(new Map<string, HTMLElement>())
  useEffect(() => { if (focused) messageNodes.current.get(focused.id)?.focus() }, [focused])
  const [assign, setAssign] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const active = { current: true }
    setBusy(true); setError('')
    void api.read(card.id, 0).then((page) => {
      if (active.current) { setMessages(page.messages); setNext(page.nextOffset) }
    }, (error: unknown) => {
      if (active.current) setError(String(error))
    }).finally(() => { if (active.current) setBusy(false) })
    return () => { active.current = false }
  }, [api, card.id, reload])
  const summary = taskId ? card.analysis?.matches.find(m => m.taskId === taskId)?.summary : card.analysis?.summary
  const evidence = [...new Set((card.analysis?.matches ?? []).filter(m => !taskId || m.taskId === taskId).flatMap(m => m.evidence))]
  const showEvidence = async (id: string) => {
    setBusy(true); setError('')
    try {
      let loaded = messages
      let offset = next
      while (!loaded.some(message => message.id === id) && offset !== null) {
        const page = await api.read(card.id, offset)
        loaded = [...loaded, ...page.messages]; offset = page.nextOffset
      }
      setMessages(loaded); setNext(offset)
      if (loaded.some(message => message.id === id)) setFocused({ id })
      else setError(t('history.evidenceMissing'))
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  const blocks: HistoryMessage[][] = []
  for (const message of messages) {
    const previous = blocks.at(-1)
    if (message.phase === 'progress' && previous?.[0]?.phase === 'progress') previous.push(message)
    else blocks.push([message])
  }
  const renderMessage = (message: HistoryMessage) => <article id={`history-${message.id}`}
    className={`${css.message} ${message.role === 'user' ? css.question : css.answer}`} key={message.id}
    aria-label={t(message.role === 'user' ? 'history.question' : message.phase === 'progress' ? 'history.progressLabel' : 'history.response')}
    tabIndex={-1} ref={(node) => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }}>
    <div className={css.messageHeader}>
      <span className={css.roleMark} aria-hidden="true">{t(message.role === 'user' ? 'history.userMark' : 'history.assistantMark')}</span>
      <strong>{message.role === 'user' ? t('history.question') : t(message.phase === 'progress' ? 'history.progressLabel' : 'history.response')}</strong>
      {message.role === 'assistant' && <span className={css.sourceBadge}>{t(`history.${card.source}`)}</span>}
      <time dateTime={message.at}>{new Date(message.at).toLocaleString()}</time>
      {message.truncated && <span>{t('history.truncated')}</span>}
    </div>
    <div className={css.messageBody}><MarkdownText text={message.role === 'user'
      ? message.text.replace(/^\s*## My request:[ \t]*\r?\n+(?=[\s\S]*\S)/, '')
      : message.text}
    labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} /></div>
  </article>
  return <section className={`${css.panel} ${css.archive} ${css.reading}`}>
    <div className={css.transcriptToolbar}><button onClick={back}>{t('history.back')}</button><button onClick={() =>{  setAssign(value => !value) }}>{t('history.assign')}</button></div>
    <h3>{card.title}</h3>
    <div className={css.meta}><span className={css.sourceBadge}>{t(`history.${card.source}`)}</span><AnalysisStatus card={card} t={t} /></div>
    <details className={css.recordDetails}><summary>{t('history.recordDetails')}</summary>
      <div className={css.meta}>{card.cwd}</div>
      <div className={css.meta}>{t('history.range')}：{new Date(card.firstAt).toLocaleString()} – {new Date(card.lastAt).toLocaleString()}</div>
      {card.analyzedAt && <div className={css.meta}>{t('history.analyzedAt')}：{new Date(card.analyzedAt).toLocaleString()} · {card.model}</div>}
      <button onClick={() => { void navigator.clipboard.writeText(`${card.sourceId}\n${card.location}`).then(() =>{  setCopied(true) }, (error: unknown) =>{  setError(String(error)) }) }}>{t(copied ? 'history.copied' : 'history.copy')}</button>
    </details>
    {!card.available && <p>{t('history.missing')}</p>}
    {summary && <section className={css.summaryBlock}><h3>{t('history.relevant')}</h3><div className={css.messageBody}><MarkdownText text={summary}
      labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} /></div></section>}
    {evidence.length > 0 && <div className={css.toolbar} aria-label={t('history.citations')}>{evidence.map((id, index) =>
      <button key={id} disabled={busy} onClick={() => { void showEvidence(id) }}>{t('history.citation', { number: index + 1 })}</button>)}</div>}
    {assign && <Assignment card={card} api={api} t={t} done={back} cancel={() => { setAssign(false) }} />}

    {error && <p role="alert" className={css.error}>{error}</p>}
    <h3>{t('history.messages')}</h3>
    {busy && <p role="status">{t('history.loading')}</p>}
    {!busy && !messages.length && <button onClick={() => { setReload(value => value + 1) }}>{t('history.reload')}</button>}
    <div className={css.transcript}>{blocks.map(block => block[0]?.phase === 'progress'
      ? <details className={css.progressMessages} key={block[0].id}
        open={focused && block.some(message => message.id === focused.id) ? true : undefined}>
        <summary>{t('history.progressMessages', { count: block.length })}</summary>
        {block.map(renderMessage)}
      </details> : block.map(renderMessage))}</div>
    {next !== null && <button disabled={busy} onClick={() => { setBusy(true); void api.read(card.id, next).then((page) => {
      setMessages(current => [...current, ...page.messages]); setNext(page.nextOffset)
    }, (error: unknown) =>{  setError(String(error)) }).finally(() =>{  setBusy(false) }) }}>{t('history.more')}</button>}
  </section>
}

/**
 * Render a paged archive or task-filtered cards, preserving the adjacent native chat.
 * @param props - Host actions, locale and optional task filter.
 * @returns inbox controls or compact task cards with an in-place transcript.
 */
export function History({ api, t, taskId = null, pollIntervalMs = 5000, onCount, taskSource = 'all' }: {
  api: HistoryActions
  t: Copy
  taskId?: string | null
  pollIntervalMs?: number
  onCount?: (count: number) => void
  taskSource?: 'all' | 'codex' | 'cursor'
}) {
  const [mode, setMode] = useState<'inbox' | 'all' | 'ignored'>('inbox')
  const [offset, setOffset] = useState(0)
  const [previous, setPrevious] = useState<number[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'codex' | 'cursor'>('all')
  const readingHost = useContext(HistoryReadingHost)
  const readingLayer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const returnTo = useRef<HistoryId | null>(null)
  const [page, setPage] = useState<HistoryPage | null>(null)
  const [selected, setSelected] = useState<HistoryCard | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [assign, setAssign] = useState<HistoryCard | null>(null)
  const [removed, setRemoved] = useState<HistoryCard | null>(null)
  useEffect(() => {
    const active = { current: true }
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const value = selected
          ? await api.list(null, selected.ignored ? 'ignored' : 'all', 0, selected.sourceId, selected.source)
          : await api.list(taskId, mode, offset, query, taskId ? taskSource : source)
        if (active.current) {
          if (selected) setSelected(current => value.items.find(item => item.id === selected.id) ?? current)
          else { setPage(value); onCount?.(value.total) }
          setError('')
        }
      }
      catch (error) { if (active.current) setError(String(error)) }
      finally { if (active.current) timer = setTimeout(() => { void load() }, pollIntervalMs) }
    }
    timer = setTimeout(() => { void load() }, 180)
    return () => { active.current = false; clearTimeout(timer) }
  }, [api, taskId, mode, offset, refresh, pollIntervalMs, onCount, query, source, taskSource,
    selected?.id, selected?.sourceId, selected?.source, selected?.ignored])
  useEffect(() => {
    if (!selected && !assign && returnTo.current) {
      panel.current?.querySelector<HTMLButtonElement>('[data-history-id="' + returnTo.current + '"]')?.focus()
      returnTo.current = null
    }
  }, [selected, assign])
  useEffect(() => { if (taskId && selected) readingLayer.current?.focus() }, [taskId, selected?.id, readingHost])
  const resetPage = () => { setOffset(0); setPrevious([]); setPage(null); setAssign(null) }
  const done = () => { setAssign(null); setSelected(null); setRefresh(value => value + 1) }
  const run = (fn: () => Promise<void>) => { setBusy(true); setActionError(''); void fn().then(done, (error: unknown) => {
    setActionError(String(error))
  }).finally(() => { setBusy(false) }) }
  if (selected && (!taskId || !readingHost)) return <Transcript card={selected} api={api} t={t} taskId={taskId} back={done} />
  return <>
    {selected && taskId && readingHost && createPortal(
      <div className={css.readingLayer} ref={readingLayer} role="dialog" aria-label={selected.title} tabIndex={-1}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); done() } }}>
        <Transcript card={selected} api={api} t={t} taskId={taskId} back={done} />
      </div>, readingHost)}
    <section ref={panel} className={`${css.panel} ${!taskId ? css.archive : ''}`} aria-label={t('history.settings')}>
      {!taskId && <div className={css.controls}>
        <div className={css.controlRow}><div className={css.tabs} role="group" aria-label={t('history.views')}>{(['inbox', 'all', 'ignored'] as const).map(value => <button key={value} aria-pressed={mode === value} onClick={() => { if (value !== mode) { setMode(value); resetPage() } }}>{t(`history.${value}`)}</button>)}</div>
          <div className={css.toolbar}>
            <button className={css.sync} disabled={busy || page?.running} onClick={() =>{  run(() => api.sync(false)) }}>{t(page?.running ? 'history.running' : 'history.sync')}</button>
            <button disabled={busy || page?.running || !page?.failedCount} onClick={() =>{  run(() => api.sync(true)) }}>{t('history.retry')}</button></div></div>
        <div className={css.filters}>
          <input type="search" aria-label={t('history.search')} placeholder={t('history.search')} value={query}
            onChange={(event) => { setQuery(event.target.value); resetPage() }} />
          <select aria-label={t('history.source')} value={source}
            onChange={(event) => { setSource(event.target.value as typeof source); resetPage() }}>
            {(['all', 'codex', 'cursor'] as const).map(value => <option key={value} value={value}>{t(value === 'all' ? 'history.allSources' : `history.${value}`)}</option>)}
          </select>
        </div>
        <div className={css.scanRow}>
          <span className={css.meta}>{!page ? t('history.loading') : `${t('history.lastScan')}：${page.lastScan ? new Date(page.lastScan).toLocaleString() : t('history.notYet')}`}</span>
          {Boolean(page?.pendingCount) && <span className={css.meta}>{t('history.pending')} {page?.pendingCount}</span>}
          {Boolean(page?.failedCount) && <span className={css.error}>{t('history.failed')} {page?.failedCount}</span>}
          <details className={css.scanDetails} open={page?.sources.some(source => source.error) ? true : undefined}>
            <summary>{t('history.scanDetails')}</summary>
            <div className={css.scanContent}>
              {page?.nextScan && <div className={css.meta}>{t('history.nextScan')}：{new Date(page.nextScan).toLocaleString()}</div>}
              <p className={css.meta}>{t('history.hint')}</p>
              {page?.sources.map(source => <div className={css.meta} key={source.source}>
                <strong>{t(`history.${source.source}`)}</strong><span>{source.path}</span>
                {source.error && <span role="alert" className={css.error}>{source.error}</span>}
              </div>)}
            </div>
          </details>
        </div>
      </div>}
      {actionError && <p role="alert" className={css.error}>{actionError}</p>}
      {removed && <div className={css.toolbar} role="status">
        <span>{t('history.deleted', { title: removed.title })}</span>
        <button disabled={busy} onClick={() => { run(async () => {
          const latest = await api.list(null, 'ignored', 0, removed.sourceId, removed.source)
          const record = latest.items.find(item => item.id === removed.id)
          if (record) await api.rule({ id: record.id, revision: record.revision, taskIds: record.taskIds, ignored: false })
          setRemoved(null)
        }) }}>{t('history.undo')}</button>
      </div>}
      {(error || page?.error) && <p role="alert" className={css.error}>{error || page?.error}</p>}
      {!page && !error && <p className={css.empty}>{t('history.loading')}</p>}
      {!page && error && <button onClick={() => { setError(''); setRefresh(value => value + 1) }}>{t('history.reload')}</button>}
      {page && !page.items.length && !taskId && <p className={css.empty}>{t(query || source !== 'all' ? 'history.noResults' : mode === 'inbox' ? 'history.inboxEmpty' : mode === 'ignored' ? 'history.ignoredEmpty' : 'history.empty')}</p>}
      {page && !page.items.length && taskId && taskSource !== 'all' && <p className={css.empty}>{t('history.noResults')}</p>}
      {page?.items.map(card => assign?.id === card.id
        ? <Assignment key={card.id} card={assign} api={api} t={t} done={done} cancel={() => { setAssign(null) }} />
        : <article className={css.card} key={card.id}>
          <button className={css.cardOpen} data-history-id={card.id} aria-label={card.title}
            onClick={() => { returnTo.current = card.id; setSelected(card) }}>
            <span className={css.cardTitle} title={card.title}>{card.title}</span>
            <span className={css.meta}><span className={css.sourceBadge}>{t(`history.${card.source}`)}</span><time dateTime={card.lastAt}>{new Date(card.lastAt).toLocaleString()}</time>
              {card.locked && <span>{t('history.fixed')}</span>}<AnalysisStatus card={card} t={t} />{!card.available && <span>{t('history.missing')}</span>}</span>
            <span className={`${css.summary} ${css.preview}`}>{(taskId ? card.analysis?.matches.find(m => m.taskId === taskId)?.summary : card.analysis?.summary)?.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1')}</span>
          </button>
          <button className={css.remove} disabled={busy} aria-label={t(card.ignored ? 'history.restore' : 'history.ignore')}
            title={t(card.ignored ? 'history.restore' : 'history.ignore')} onClick={() => { run(async () => {
              await api.rule({ id: card.id, revision: card.revision, taskIds: card.taskIds, ignored: !card.ignored })
              setPage(current => current ? {
                ...current, items: current.items.filter(item => item.id !== card.id), total: current.total - 1,
              } : current)
              if (!card.ignored) setRemoved(card)
              setOffset(0); setPrevious([])
            }) }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {card.ignored ? <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></> : <><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></>}
            </svg>
          </button>
          {card.error && <p role="alert" className={css.error}>{t('history.failed')}：{card.error}</p>}
          <div className={`${css.toolbar} ${css.cardActions}`}>
            {!card.ignored && <button onClick={() =>{  returnTo.current = card.id; setAssign(card) }}>{t('history.assign')}</button>}
          </div>
        </article>)}
      <div className={`${css.toolbar} ${!taskId ? css.pagination : ''}`}>
        {page && !taskId && <span className={css.meta}>{t('history.results', { count: page.total })}</span>}
        {previous.length > 0 && <button disabled={!page} onClick={() => {
          setOffset(previous.at(-1) ?? 0); setPrevious(values => values.slice(0, -1)); setPage(null); setAssign(null)
        }}>{t('history.previous')}</button>}
        {page?.nextOffset !== null && page?.nextOffset !== undefined && <button onClick={() =>{  setPrevious(values => [...values, offset]); setOffset(page.nextOffset ?? offset); setPage(null); setAssign(null) }}>{t('history.next')}</button>}</div>
    </section></>
}
