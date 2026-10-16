/** Drag-to-schedule weekly work board over the shared durable journal. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type {
  JournalRow,
  JournalId,
  JournalWrite,
} from '@xrunmasterx/dsh-personal-host/client'
import { taskSummary } from './task-summary.ts'
import { JournalToolbar } from './JournalToolbar.tsx'
import { TaskDocument } from './TaskDocument.tsx'
import { TaskDetails } from './TaskDetails.tsx'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JournalActions } from './journal-api.ts'
import { useJournalBoard } from './use-journal-board.ts'
import { localDay, shift, distance, monday } from './journal-calendar.ts'
import common from './Journal.module.css'
import css from './Planner.module.css'

type Copy = TranslateNS<'personal-workbench'>
type Span = { from: string; to: string }
function spanOf(row: JournalRow, today: string): Span | null {
  const manual = row.item.timeline
  if (manual?.followToday !== undefined) return {
    from: manual.from,
    to: manual.followToday ? (row.execution?.endedOn ?? today) : manual.to,
  }
  if (!row.execution) return null
  return {
    from: row.execution.startedOn,
    to: row.execution.endedOn ?? (today < row.execution.startedOn ? row.execution.startedOn : today),
  }
}

function TaskSummary({ row, t, actions }: { row: JournalRow; t: Copy; actions?: ReactNode }) {
  const summary = taskSummary(row.item)
  const nextAction = row.item.description?.split('\n')
    .map(line => line.trim().replace(/^[-*+]\s+/, ''))
    .find(line => /^(下一步|待办|Next step)[:：]/i.test(line))
  return (
    <div className={css.taskCopy}>
      <div className={css.cardMeta}>
        <div className={css.cardLabels}>
          <span className={css.status}>{t(`journal.${row.item.status}`)}</span>
          {row.item.links.length > 0 && <span className={css.source} role="img"
            aria-label={t('planner.linked')} title={row.item.links.map(link => link.title || link.url).join('\n')}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
            </svg>
          </span>}
        </div>
        <div className={css.cardControls}>
          {actions}
          <span className={css.grip} title={t('gantt.move')} aria-hidden="true">⠿</span>
        </div>
      </div>
      <strong className={css.taskTitle} title={row.item.title}>{row.item.title}</strong>
      {summary && <p className={css.summary} title={summary}>{summary}</p>}
      {nextAction && nextAction !== summary && <p className={css.nextAction}>{nextAction}</p>}
    </div>
  )
}

function GanttRow({
  row,
  week,
  today,
  t,
  busy,
  open,
  write,
  beginDrag,
  endDrag,
  dropAt,
  dragOver,
  dragging,
  dropEdge,
  moveUp,
  moveDown,
  expanded,
  toggle,
  readImage,
}: {
  row: JournalRow
  week: string
  today: string
  t: Copy
  busy: boolean
  open: () => void
  expanded: boolean
  toggle: () => void
  readImage: JournalActions['journalReadImage']
  write: (row: JournalRow, change: Partial<JournalWrite>) => void
  beginDrag: (row: JournalRow) => void
  endDrag: () => void
  dropAt: (row: JournalRow, after: boolean) => void
  dragOver: (row: JournalRow, after: boolean) => boolean
  dragging: boolean
  dropEdge: string | undefined
  moveUp: (() => void) | undefined
  moveDown: (() => void) | undefined
}) {
  const shown = spanOf(row, today)
  const [preview, setPreview] = useState<Span | null>(null)
  const gesture = useRef<{ range: Span; side: 'from' | 'to'; x: number; unit: number; revision: number; preview: Span } | null>(null)
  const range = preview ?? shown
  const first = range ? Math.max(0, distance(week, range.from)) : 0
  const last = range ? Math.min(6, distance(week, range.to)) : 0
  const inWeek = shown !== null && first <= last
  const clamp = (date: string) => date < week ? week : date > shift(week, 6) ? shift(week, 6) : date
  const resize = (span: Span, side: 'from' | 'to', date: string): Span => {
    const next = clamp(date)
    return side === 'from' ? { from: next > span.to ? span.to : next, to: span.to }
      : { from: span.from, to: next < span.from ? span.from : next }
  }
  const save = (span: Span, revision = row.revision) =>{  write({ ...row, revision }, {
    timeline: { ...span, followToday: span.to === today && (row.item.status === 'active' || row.item.status === 'blocked') },
    reason: t('gantt.rangeReason'),
  }) }
  const cancel = () => { gesture.current = null; setPreview(null) }
  const handle = (side: 'from' | 'to') => <button className={css.handle} data-side={side} disabled={busy}
    aria-label={t(side === 'from' ? 'gantt.resizeStart' : 'gantt.resizeEnd', { title: row.item.title })}
    onDoubleClick={(e) =>{  e.stopPropagation() }}
    onPointerDown={(e) => {
      if (!shown) return
      e.preventDefault(); e.stopPropagation()
      e.currentTarget.focus()
      const track = e.currentTarget.closest('[data-track]')
      if (!track) return
      gesture.current = { range: shown, side, x: e.clientX,
        unit: track.getBoundingClientRect().width / 7, revision: row.revision, preview: shown }
      e.currentTarget.setPointerCapture(e.pointerId)
    }}
    onPointerMove={(e) => {
      const drag = gesture.current
      if (!drag) return
      const days = Math.round((e.clientX - drag.x) / drag.unit)
      drag.preview = days === 0 ? drag.range : resize(drag.range, drag.side, shift(clamp(drag.range[drag.side]), days))
      setPreview(drag.preview)
    }}
    onPointerUp={(e) => {
      const drag = gesture.current
      cancel()
      e.currentTarget.releasePointerCapture(e.pointerId)
      if (drag && (drag.range.from !== drag.preview.from || drag.range.to !== drag.preview.to)) save(drag.preview, drag.revision)
    }}
    onPointerCancel={cancel} onLostPointerCapture={cancel}
    onKeyDown={(e) => {
      if (e.key === 'Escape') { cancel(); e.stopPropagation(); return }
      if (!shown || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
      e.preventDefault(); e.stopPropagation()
      const next = resize(shown, side, shift(clamp(shown[side]), e.key === 'ArrowLeft' ? -1 : 1))
      if (next.from !== shown.from || next.to !== shown.to) save(next)
    }} />
  return (
    <article
      className={`${css.card} ${css.ganttRow}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open()
      }}
      data-status={row.item.status}
      aria-label={row.item.title}
      onDoubleClick={open}
      draggable={!busy}
      data-dragging={dragging}
      data-drop-edge={dropEdge}
      onDragStart={(e) => {
        if (
          busy ||
          gesture.current ||
          (e.target instanceof Element && e.target.closest('input,textarea,select,details,button,[data-task-preview]'))
        ) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData('text/plain', row.item.id)
        e.dataTransfer.effectAllowed = 'move'
        beginDrag(row)
      }}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        const after =
          e.clientY >
          e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2
        if (dragOver(row, after)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        dropAt(
          row,
          e.clientY >
            e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2,
        )
      }}
    >
      <div className={css.previewTrigger} onClick={(e) => {
        if (e.target instanceof Element && !e.target.closest('button,details,a')) toggle()
      }}>
        <button className={css.disclosure} aria-label={t('planner.toggleBrief', { title: row.item.title })}
          aria-expanded={expanded} aria-controls={`brief-${row.item.id}`} onClick={toggle}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true" style={{ transform: expanded ? 'rotate(90deg)' : undefined }}><path d="m4 2 4 4-4 4" /></svg>
        </button>
        <TaskSummary row={row} t={t} actions={
          <div className={css.rowActions}>
            {row.item.status !== 'done' && row.item.status !== 'canceled' && (
              <button
                disabled={busy}
                onClick={() => {
                  write(row, { status: 'done', reason: t('gantt.finishReason') })
                }}
              >
                {t('gantt.finish')}
              </button>
            )}
            <details
              className={css.menu}
              onDoubleClick={(e) => {
                e.stopPropagation()
              }}
            >
              <summary aria-label={t('gantt.more')}>⋯</summary>
              <div
                className={css.menuItems}
                onClick={(e) => {
                  if (e.target instanceof Element && e.target.closest('button')) {
                    e.currentTarget.parentElement?.removeAttribute('open')
                  }
                }}
              >
                <button disabled={busy || !moveUp} onClick={moveUp} aria-label={t('gantt.up')}>
                  {t('gantt.up')}
                </button>
                <button disabled={busy || !moveDown} onClick={moveDown} aria-label={t('gantt.down')}>
                  {t('gantt.down')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    write(row, { status: 'todo', timeline: null, reason: t('gantt.returnReason') })
                  }}
                >
                  {t('gantt.return')}
                </button>
              </div>
            </details>
          </div>
        } />
      </div>
      <div className={css.track} data-track="true" title={t('gantt.spanHelp')}>
        <svg className={css.ticks} aria-hidden="true" viewBox="0 0 700 9" preserveAspectRatio="none">
          <path d="M0 0v9M100 0v9M200 0v9M300 0v9M400 0v9M500 0v9M600 0v9M700 0v9"
            fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" shapeRendering="crispEdges" />
        </svg>
        {inWeek && range && (
          <div className={css.bar} title={`${range.from} — ${range.to}`}
            style={{ gridColumn: `${first + 1} / span ${last - first + 1}` }}>
            <div className={css.elapsed} aria-hidden="true" />
            {handle('from')}
            {handle('to')}
          </div>
        )}
        {inWeek && range && <span className={css.dateLabel}>
          {range.from === range.to ? range.from.slice(5) : `${range.from.slice(5)} — ${range.to.slice(5)}`}
        </span>}
        {!shown && <span className={css.undated}>{t('gantt.undated')}</span>}
        {shown && !inWeek && <button className={css.outside} disabled={busy}
          onClick={() =>{  save({ from: shown.from > today ? today : shown.from, to: today }) }}>
          {t('gantt.resumeToday')}
        </button>}
      </div>
      {expanded && <section id={`brief-${row.item.id}`} className={css.inlineBrief} data-task-preview="true"
        aria-label={t('task.brief')} onDoubleClick={e =>{  e.stopPropagation(); }}>
        <div className={css.briefActions}><button onClick={open}>{t('planner.details')}</button></div>
        <TaskDocument text={row.item.description || t('task.emptyBrief')} readImage={readImage}
          failedLabel={t('task.imageFailed')} retryLabel={t('task.imageRetry')}
          labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />
      </section>}
    </article>
  )
}

/** Backlog and execution Gantt view over revision-checked journal records.
 * @param props - journal callbacks.
 * @returns two-pane board or in-pane task document.
 */
export function Planner({
  api,
  t,
  pollIntervalMs,
  sessions,
  archivedSessionIds,
  onTaskDetail,
  boardActions,
}: {
  api: JournalActions
  t: Copy
  pollIntervalMs: number
  archivedSessionIds: WorkspaceSnapshot['archivedSessionIds']
  sessions: SessionListState
  onTaskDetail: (open: boolean) => void
  boardActions?: ReactNode
}) {
  const {
    rows,
    today,
    loading,
    busy,
    needsSync,
    error: readError,
    saved,
    undo,
    run,
    changed,
    refresh,
  } = useJournalBoard(api, pollIntervalMs)
  const error = needsSync ? t('gantt.syncFailed', { message: readError }) : readError
  const notice = saved ? t('journal.saved') : ''
  const [week, setWeek] = useState(() => monday(localDay()))
  const currentWeek = monday(today)
  const previousCurrentWeek = useRef(currentWeek)
  useEffect(() => {
    const previous = previousCurrentWeek.current
    previousCurrentWeek.current = currentWeek
    setWeek(viewed => viewed === previous ? currentWeek : viewed)
  }, [currentWeek])
  const [search, setSearch] = useState('')
  const [taskSearch, setTaskSearch] = useState('')
  const [backlogOpen, setBacklogOpen] = useState(false)
  const [showEnded, setShowEnded] = useState(false)
  const [timelineVisible, setTimelineVisible] = useState(true)
  const [dragRows, setDragRows] = useState<JournalRow[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState<JournalId | null>(null)
  const [detailId, setDetailId] = useState<JournalId | null>(null)
  const detail = rows.find(row => row.item.id === detailId) ?? null
  const boardElement = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(0)
  const listScroll = useRef(0)
  const backlogScroll = useRef(0)
  const scrollOwner = useRef<HTMLElement | null>(null)
  const rememberBoardScroll = () => {
    scrollOwner.current = boardElement.current?.closest<HTMLElement>('[data-work-scroll]') ?? null
    scrollPosition.current = scrollOwner.current?.scrollTop ?? 0
  }
  const openTask = (id: JournalId) => { rememberBoardScroll(); setDetailId(id) }
  const showingDetail = creating || detail !== null
  const [contextError, setContextError] = useState('')
  const beginBoardSession = api.beginBoardSession
  useEffect(() => {
    if (showingDetail) return
    const controller = new AbortController()
    setContextError('')
    void beginBoardSession(week, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setContextError(error instanceof Error ? error.message : String(error))
    })
    return () => { controller.abort() }
  }, [week, showingDetail, beginBoardSession])
  useLayoutEffect(() => {
    if (scrollOwner.current) scrollOwner.current.scrollTop = showingDetail ? 0 : scrollPosition.current
  }, [showingDetail])
  useEffect(() => {
    onTaskDetail(creating || detail !== null)
  }, [creating, detail !== null, onTaskDetail])
  useEffect(() => () =>{  onTaskDetail(false) }, [onTaskDetail])
  const drag = useRef<JournalRow | null>(null)
  const [over, setOver] = useState(false)
  const [dragged, setDragged] = useState<JournalId | null>(null)
  const [target, setTarget] = useState<string | null>(null)
  const endDrag = () => {
    drag.current = null
    setDragged(null)
    setDragRows(null)
    setTarget(null)
    setOver(false)
  }
  const beginDrag = (row: JournalRow) => {
    setDragRows(rows)
    drag.current = row
    setDragged(row.item.id)
  }
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', cancel)
    return () => {
      window.removeEventListener('keydown', cancel)
    }
  }, [])
  const write = (row: JournalRow, change: Partial<JournalWrite>) =>
    void run(async () => {
      changed(
        await api.journalWrite({
          requestId: randomUUID() as JournalId,
          itemId: row.item.id,
          expectedRevision: row.revision,
          operation: 'update',
          day: localDay(),
          reason: t('journal.editReason'),
          ...change,
        }),
      )
    })
  const start = (row: JournalRow, before?: JournalId | null) => {
    setWeek(monday(localDay()))
    setShowEnded(false)
    write(row, { status: 'active', timeline: null, ...(before !== undefined ? { reorderBefore: before } : {}), reason: t('gantt.startReason') })
  }
  const displayedRows = dragRows ?? rows
  const backlog = displayedRows.filter(
    row =>
      row.item.status === 'todo' &&
      `${row.item.title} ${taskSummary(row.item)}`.toLowerCase().includes(search.toLowerCase()),
  )
  const weekRows = displayedRows
    .filter((row) => {
      if (row.item.status === 'todo') return false
      const span = spanOf(row, today)
      return !span || (span.from <= shift(week, 6) && span.to >= week) ||
        (week === monday(today) && (row.item.status === 'active' || row.item.status === 'blocked'))
    })
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        (a.execution?.startedAt ?? '9999').localeCompare(b.execution?.startedAt ?? '9999') ||
        a.item.id.localeCompare(b.item.id),
    )
  const ended = weekRows.filter(row => row.item.status === 'done' || row.item.status === 'canceled')
  const active = weekRows.filter(row => row.item.status === 'active' || row.item.status === 'blocked')
  const ongoing = (showEnded ? ended : active).filter(row => `${row.item.title} ${taskSummary(row.item)} ${row.item.nextAction}`.toLowerCase().includes(taskSearch.toLowerCase()))
  const reorder = (row: JournalRow, before: JournalId | null) => {
    if (before === row.item.id) return
    write(row, { operation: 'reorder', reorderBefore: before, reason: t('gantt.reorderReason') })
  }
  const dropAt = (targetRow: JournalRow, after: boolean) => {
    const source = drag.current
    endDrag()
    if (!source || showEnded) return
    if (source.item.id === targetRow.item.id) return
    const peers = ongoing.filter(row => row.item.id !== source.item.id)
    const position = peers.findIndex(row => row.item.id === targetRow.item.id)
    const before = after ? (peers[position + 1]?.item.id ?? null) : targetRow.item.id
    if (source.item.status === 'todo') start(source, before)
    else reorder(source, before)
  }
  if (detail || creating)
    return (
      <TaskDetails
        key={detail?.item.id ?? 'new'}
        row={detail}
        toolbar={boardActions}
        created={(id) => { setDetailId(id); setCreating(false); setSearch('') }}
        api={api}
        t={t}
        sessions={sessions}
        archivedSessionIds={archivedSessionIds}
        run={run}
        changed={changed}
        close={() =>{ setDetailId(null); setCreating(false) }}
        busy={busy}
        error={error}
        refresh={refresh}
        needsSync={needsSync}
      />
    )
  return (
    <div ref={boardElement} className={`${common.journal} ${css.planner}`}>
      {contextError && <p role="alert" className={common.error}>{contextError}</p>}
      <JournalToolbar title={t('nav.board')} week={week} onWeekChange={setWeek} t={t}
        help={<>
          <p>{t('gantt.hint')}</p>
          <span className={css.legend}>
            {(['active', 'blocked', 'done'] as const).map(status => (
              <span key={status} data-status={status}>{t(`journal.${status}`)}</span>
            ))}
          </span>
        </>} actions={boardActions} />
      <div className={css.feedback} aria-live="polite" hidden={!error && !busy && !loading && !notice && !needsSync && !undo}>
        {error ? (
          <span role="alert" className={common.error}>
            {error}
          </span>
        ) : (
          <span>{busy ? t('gantt.saving') : loading ? t('loading') : notice}</span>
        )}
        {needsSync && (
          <button
            onClick={() => {
              void refresh()
            }}
          >
            {t('journal.refresh')}
          </button>
        )}
        {undo && !busy && (
          <button
            onClick={() =>
              void run(async () => {
                changed(
                  await api.journalWrite({
                    requestId: randomUUID() as JournalId,
                    itemId: undo.itemId,
                    expectedRevision: undo.revision,
                    operation: 'undo',
                    day: localDay(),
                    reason: t('journal.undoReason'),
                  }),
                )
              })
            }
          >
            {t('journal.undo')}
          </button>
        )}
      </div>
      <div className={css.viewControls}>
        <button className={css.backlogToggle} aria-expanded={backlogOpen} disabled={dragged !== null} onClick={() =>{  setBacklogOpen(value => !value) }}>{t('gantt.backlog')} · {displayedRows.filter(row => row.item.status === 'todo').length}</button>
        <div className={css.viewTabs}><button aria-pressed={!showEnded} disabled={dragged !== null} onClick={() =>{  setShowEnded(false) }}>{t('planner.current')} · {active.length}</button>
          <button aria-pressed={showEnded} disabled={dragged !== null} onClick={() =>{  setShowEnded(true) }}>{t('planner.ended')} · {ended.length}</button></div>
        <input className={css.taskSearch} aria-label={t('planner.searchTasks')} placeholder={t('planner.searchTasks')} value={taskSearch} disabled={dragged !== null} onChange={(e) =>{  setTaskSearch(e.target.value) }} />
        <button aria-pressed={timelineVisible} disabled={dragged !== null} onClick={() =>{  setTimelineVisible(value => !value) }}>{t('planner.timeline')}</button>
      </div>
      <div className={css.board} data-backlog={backlogOpen} data-timeline={timelineVisible}>
        <aside
          ref={(element) => { if (element) element.scrollTop = backlogScroll.current }}
          onScroll={(e) => { backlogScroll.current = e.currentTarget.scrollTop }}
          hidden={!backlogOpen}
          className={css.backlog}
          aria-label={t('gantt.backlog')}
          data-over={target === 'backlog'}
          onDragOver={(e) => {
            if (drag.current && drag.current.item.status !== 'todo') {
              e.preventDefault()
              setTarget('backlog')
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            const row = drag.current
            endDrag()
            if (row && row.item.status !== 'todo')
              write(row, { status: 'todo', timeline: null, reason: t('gantt.returnReason') })
          }}
        >
          <header className={css.panelHead}>
            <h2>
              {t('gantt.backlog')} <small>{backlog.length}</small>
            </h2>
            <button disabled={dragged !== null} aria-label={t('planner.closeBacklog')} onClick={() =>{  setBacklogOpen(false) }}>×</button>
            <button className={css.add} disabled={busy} aria-label={t('task.new')} title={t('task.new')}
              onClick={() => { rememberBoardScroll(); setCreating(true) }}>＋</button>
          </header>
          <div className={css.poolControls}>
            <input
              className={css.search}
              aria-label={t('journal.search')}
              placeholder={t('journal.search')}
              disabled={dragged !== null}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
              }}
            />
          </div>
          <div className={css.backlogCards}>
            {backlog.map(row => (
              <article
                key={row.item.id}
                className={css.card}
                data-status="todo"
                data-dragging={dragged === row.item.id}
                aria-label={row.item.title}
                tabIndex={0}
                draggable={!busy}
                onDragStart={(e) => {
                  if (busy) {
                    e.preventDefault()
                    return
                  }
                  beginDrag(row)
                  e.dataTransfer.setData('text/plain', row.item.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={endDrag}
                onDoubleClick={() => {
                  openTask(row.item.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) openTask(row.item.id)
                }}
              >
                <TaskSummary row={row} t={t} actions={<button disabled={busy} onDoubleClick={(e) =>{  e.stopPropagation() }} onClick={() =>{  start(row) }}>{t('gantt.start')}</button>} />
              </article>
            ))}
            {!backlog.length && (
              <p className={css.empty}>{t(search ? 'planner.noMatches' : 'gantt.noBacklog')}</p>
            )}
          </div>
        </aside>
        <section
          className={css.ongoing}
          data-over={over}
          aria-label={t(showEnded ? 'planner.ended' : 'gantt.ongoing')}
          onDragOver={(e) => {
            if (drag.current && !showEnded) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setOver(true)
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            const row = drag.current
            endDrag()
            if (row && !showEnded) {
              if (row.item.status === 'todo') start(row)
              else reorder(row, null)
            }
          }}
        >
          <div className={css.ganttScroll}
            ref={(element) => { if (element) element.scrollTop = listScroll.current }}
            onScroll={(e) => { listScroll.current = e.currentTarget.scrollTop }}>
            <div className={css.gantt}>
              <div className={css.tableHead}><span>{t('planner.progressColumn')}</span><div className={css.axis}>
                {Array.from({ length: 7 }, (_, i) => shift(week, i)).map(date => (
                  <div key={date} data-today={date === today}>
                    <span>
                      {new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}
                    </span>
                    <strong>{Number(date.slice(-2))}</strong>
                  </div>
                ))}
              </div>
              </div>
              <div className={css.ganttCards}>
                {ongoing.map((row, index) => (
                  <GanttRow
                    key={row.item.id}
                    row={row}
                    expanded={expandedId === row.item.id}
                    toggle={() =>{  setExpandedId(current => current === row.item.id ? null : row.item.id); }}
                    readImage={api.journalReadImage}
                    week={week}
                    today={today}
                    t={t}
                    busy={busy}
                    open={() => {
                      openTask(row.item.id)
                    }}
                    write={write}
                    beginDrag={beginDrag}
                    endDrag={endDrag}
                    dropAt={dropAt}
                    dragging={dragged === row.item.id}
                    dropEdge={
                      target === `${row.item.id}:before`
                        ? 'before'
                        : target === `${row.item.id}:after`
                          ? 'after'
                          : undefined
                    }
                    dragOver={(value, after) => {
                      if (showEnded || !drag.current || drag.current.item.id === value.item.id) return false
                      setTarget(`${value.item.id}:${after ? 'after' : 'before'}`)
                      return true
                    }}
                    moveUp={
                      index > 0
                        ? () => {
                          reorder(row, ongoing[index - 1]?.item.id ?? null)
                        }
                        : undefined
                    }
                    moveDown={
                      index < ongoing.length - 1
                        ? () => {
                          reorder(row, ongoing[index + 2]?.item.id ?? null)
                        }
                        : undefined
                    }
                  />
                ))}
                {dragged && drag.current?.item.status !== 'todo' && (
                  <div className={css.endDrop}>{t('gantt.end')}</div>
                )}
                {!ongoing.length && <div className={css.dropHint}>{t(showEnded ? 'planner.noEnded' : taskSearch ? 'planner.noMatches' : 'gantt.dropHere')}</div>}
              </div>
            </div>
          </div>
        </section>
      </div>
      <div
        role="region"
        aria-label={t('gantt.trash')}
        title={t('gantt.trashHelp')}
        className={css.trash}
        hidden={dragged === null}
        data-dragging={dragged !== null}
        data-over={target === 'trash'}
        onDragOver={(e) => {
          if (drag.current && !busy) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setTarget('trash')
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTarget(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const row = drag.current
          endDrag()
          if (row && !busy)
            write(row, { operation: 'delete', reason: t('gantt.deleteReason') })
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </svg>
        <span>{t('gantt.trashHelp')}</span>
      </div>
    </div>
  )
}
