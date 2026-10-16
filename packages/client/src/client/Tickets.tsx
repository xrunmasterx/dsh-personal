/** Source-ticket views share navigation while retaining separate snapshot and evidence queries. */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InvestigationTarget, ReportRef, TapdTodoItem, WorkbenchInfo,
} from '@xrunmasterx/dsh-personal-api/client'
import type { WorkbenchClient, WorkbenchData } from './data.ts'
import type { JournalActions } from './Journal.tsx'
import { Badge, date, kindTone, priorityTone, runTone, statusTone } from './presentation.tsx'
import common from './Workbench.module.css'
import css from './Tickets.module.css'

interface TicketsProps {
  data: WorkbenchData & { info: WorkbenchInfo }
  t: TranslateNS<'personal-workbench'>
  callbacks: Pick<WorkbenchClient, 'refreshTapd' | 'loadLinkedCrashes'> & Pick<JournalActions, 'assist'>
  investigate: (target: InvestigationTarget, samples: ReportRef[]) => void
  history: (target: InvestigationTarget) => void
  mode: 'tapd' | 'crash'
  navigate: (mode: 'tapd' | 'crash') => void
  actions?: ReactNode
}

function Metadata({ values }: { values: Array<[string, ReactNode]> }) {
  return <dl className={css.metadata}>{values.map(([label, value]) => (
    <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
  ))}</dl>
}

function Chevron() {
  return <svg className={css.chevron} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
}

function TapdItems({ data, t, callbacks, investigate, history, openLinks }: TicketsProps & {
  openLinks: (id: string) => void
}) {
  const [kind, setKind] = useState<'all' | TapdTodoItem['kind']>('all')
  const [filter, setFilter] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [state, setState] = useState('')
  const snapshot = data.tapd?.snapshot
  const items = snapshot?.items.filter(item =>
    (kind === 'all' || item.kind === kind) && (!workspace || item.workspaceId === workspace) &&
    (!state || item.status === state) && `${item.title} ${item.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  ) ?? []
  const hasFilters = kind !== 'all' || Boolean(filter || workspace || state)
  const counts = { all: snapshot?.total ?? 0, bug: snapshot?.counts.bugs ?? 0,
    story: snapshot?.counts.stories ?? 0, task: snapshot?.counts.tasks ?? 0 }

  return <>
    <div className={css.tools}>
      <input type="search" aria-label={t('filter')} placeholder={t('filter')} value={filter}
        onChange={(event) => { setFilter(event.target.value) }} />
      <details className={css.filterMenu}>
        <summary>{t('filterAction')}{(workspace || state) && <span className={css.filterDot} />}</summary>
        <div className={css.filterFields}>
          <label>{t('workspace')}<select value={workspace} onChange={(event) => { setWorkspace(event.target.value) }}>
            <option value="">{t('allWorkspaces')}</option>
            {snapshot?.workspaceIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select></label>
          <label>{t('state')}<select value={state} onChange={(event) => { setState(event.target.value) }}>
            <option value="">{t('allStates')}</option>
            {[...new Set(snapshot?.items.map(item => item.status))].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select></label>
        </div>
      </details>
      <button disabled={data.busy.includes('tapd')} title={t('tickets.syncHelp')}
        onClick={() => void callbacks.refreshTapd()}>{t(data.busy.includes('tapd') ? 'syncing' : 'tickets.sync')}</button>
    </div>
    <div className={css.listControls}>
      <div className={css.kinds} role="group" aria-label={t('workOverview')}>
        {(['all', 'bug', 'story', 'task'] as const).map(value => (
          <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value) }}>
            {t(value === 'all' ? 'tickets.all' : `kind.${value}`)}<span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {hasFilters && <button className={css.clear} onClick={() => {
        setKind('all'); setFilter(''); setWorkspace(''); setState('')
      }}>{t('clearFilters')}</button>}
    </div>
    <div className={css.caption} aria-live="polite">
      <span>{t('itemsShown', { count: items.length })}</span>
      {snapshot && <span>{t('synced', { time: date(snapshot.fetchedAt, t) })}
        {Date.parse(snapshot.cacheExpiresAt) < Date.now() && ` · ${t('expired')}`}</span>}
    </div>
    {data.tapd?.lastError && <div className={common.warning} role="status">
      {t('stale')}<details><summary>{t('error')}</summary>{data.tapd.lastError}</details>
    </div>}
    <div className={css.list}>
      {items.map((item) => {
        const url = `https://tapd.woa.com/tapd_fe/${item.workspaceId}/${item.kind}/detail/${item.id}`
        const target = { kind: 'tapd' as const, url }
        const canInvestigate = item.kind === 'bug' && data.info.tapdWorkspaceIds.includes(item.workspaceId)
        return <details className={css.item} key={item.key}>
          <summary className={css.row}>
            <span className={css.rowBody}>
              <span className={css.labels}>
                <Badge tone={kindTone(item.kind)}>{t(`kind.${item.kind}`)}</Badge>
                <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                {item.priority && <span className={css.priority} title={`${t('priority')}: ${item.priority}`}>
                  <Badge tone={priorityTone(item.priority)}>{item.priority}</Badge>
                </span>}
              </span>
              <span className={css.title}>{item.title}</span>
            </span>
            <Chevron />
          </summary>
          <div className={css.detail}>
            <Metadata values={[
              [t('tickets.id'), item.id], [t('owner'), item.owner ?? t('unknown')],
              [t('workspace'), item.workspaceId], [t('iteration'), item.iteration ?? t('unknown')],
              [t('created'), date(item.createdAt, t)],
            ]} />
            <div className={css.actions}>
              <button className={common.primary}
                onClick={() => void callbacks.assist(t('journal.sourcePrompt', { title: item.title, url }))}>
                {t('journal.sourceAction')}
              </button>
              {canInvestigate && <>
                <button onClick={() => { investigate(target, []) }}>{t('investigate')}</button>
                <button onClick={() => { history(target) }}>{t('history')}</button>
              </>}
              {item.kind === 'bug' && !canInvestigate && <span className={common.meta}>
                {t('outsideInvestigationScope')}
              </span>}
              {item.kind === 'bug' && <button onClick={() => { openLinks(item.id) }}>{t('tickets.showLinks')}</button>}
              <a href={url} target="_blank" rel="noreferrer">{t('original')} <span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </details>
      })}
      {!items.length && <div className={common.empty}>{t(snapshot ? 'emptyTapd' : 'noCache')}</div>}
    </div>
  </>
}

function LinkedCrashes({ data, t, callbacks, investigate, history, filter, setFilter }: TicketsProps & {
  filter: string
  setFilter: (value: string) => void
}) {
  const page = data.linkedCrashes
  const busy = data.busy.includes('linked-crashes')
  return <>
    <form className={css.tools} onSubmit={(event) => {
      event.preventDefault()
      void callbacks.loadLinkedCrashes({ offset: 0, text: filter.trim() })
    }}>
      <input type="search" aria-label={t('filterLinked')} placeholder={t('filterLinked')} value={filter}
        onChange={(event) => { setFilter(event.target.value) }} />
      <button disabled={busy} type="submit">{t('search')}</button>
      <button disabled={busy} type="button" title={t('tickets.refreshLinksHelp')}
        onClick={() => void callbacks.loadLinkedCrashes(page?.query ?? { offset: 0, text: '' })}>{t('refresh')}</button>
    </form>
    <div className={css.caption} aria-live="polite">
      <span>{t('tickets.linksScope')}</span>
      {page && <span>{t('page', { count: page.items.length, total: page.total })}</span>}
      {page?.query.text && <button className={css.clear} disabled={busy} onClick={() => {
        setFilter(''); void callbacks.loadLinkedCrashes({ offset: 0, text: '' })
      }}>{t('clearFilters')}</button>}
    </div>
    {!data.info.crashSightConfigured && <p className={common.warning}>{t('notConfigured')}</p>}
    <div className={css.list} aria-busy={busy}>
      {page?.items.map((item) => {
        const target = { kind: 'tapd' as const, url: item.tapd.url }
        return <details className={css.item} key={item.key}>
          <summary className={css.row}>
            <span className={css.rowBody}>
              <span className={css.labels}>
                <Badge tone="violet">{t('crashSight')}</Badge>
                <Badge tone={item.tapd.current ? 'info' : 'neutral'}>
                  {t(item.tapd.current ? 'currentTodo' : 'historicalLink')}
                </Badge>
                {item.tapd.status && <Badge tone={statusTone(item.tapd.status)}>{item.tapd.status}</Badge>}
                <span className={css.trailing}>{t('tickets.reports', { count: item.crash.reportCount })}</span>
              </span>
              <span className={css.title}>{item.tapd.title}</span>
              <span className={css.issue}>{item.crash.issueId}</span>
            </span>
            <Chevron />
          </summary>
          <div className={css.detail}>
            <Metadata values={[
              [t('tickets.id'), item.tapd.id], [t('owner'), item.tapd.owner ?? t('unknown')],
              [t('tickets.app'), item.crash.appId], [t('platform'), item.crash.platformId],
              [t('version'), item.crash.versions.join(' · ') || t('unknown')],
              [t('relatedRuns'), item.runCount], [t('latestInvestigation'), date(item.latestRun.createdAt, t)],
              [t('tickets.runState'), <Badge tone={runTone(item.latestRun.status)} key="status">
                {t(`status.${item.latestRun.status}`)}</Badge>],
            ]} />
            <div className={css.actions}>
              <button className={common.primary} onClick={() => void callbacks.assist(t('journal.sourcePrompt', {
                title: t('journal.crashTitle', { title: item.tapd.title, app: item.crash.appId,
                  platform: item.crash.platformId, issue: item.crash.issueId }), url: item.tapd.url,
              }))}>{t('journal.sourceAction')}</button>
              <button onClick={() => { investigate(target, []) }}>{t('investigateAgain')}</button>
              <button onClick={() => { history(target) }}>{t('history')}</button>
              <span className={common.meta}>{t(item.latestRun.mode)}</span>
              <a href={item.tapd.url} target="_blank" rel="noreferrer">{t('original')} <span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </details>
      })}
      {!page?.items.length && <div className={common.empty}>
        {t(busy ? 'loadingLinked' : page?.summary.issues ? 'noLinkedMatches' : 'noLinkedCrashes')}
      </div>}
    </div>
    {page && page.total > data.info.pageSize && <div className={common.pager}>
      <button disabled={page.query.offset === 0 || busy} onClick={() => void callbacks.loadLinkedCrashes({
        ...page.query, offset: Math.max(0, page.query.offset - data.info.pageSize),
      })}>{t('previous')}</button>
      <button disabled={page.nextOffset === null || busy} onClick={() => {
        if (page.nextOffset !== null) void callbacks.loadLinkedCrashes({ ...page.query, offset: page.nextOffset })
      }}>{t('next')}</button>
    </div>}
  </>
}

/**
 * Render one source entry with independently filtered current work and recorded crash associations.
 * @param props Source data, view selection and existing workbench actions.
 * @returns Source navigation and the selected list; switching preserves local filters and disclosures.
 */
export function Tickets(props: TicketsProps) {
  const { t, mode, navigate, actions } = props
  const [linkedFilter, setLinkedFilter] = useState(props.data.linkedCrashes?.query.text ?? '')
  return <section className={css.tickets}>
    <header className={css.header}>
      <h1>{t('nav.tapd')}</h1>
      <div className={css.views} role="group" aria-label={t('tickets.views')}>
        {(['tapd', 'crash'] as const).map(view => <button key={view} aria-pressed={mode === view}
          onClick={() => { navigate(view) }}>{t(`tickets.${view}`)}</button>)}
      </div>
      <div className={css.headerActions}>
        <details className={css.help}>
          <summary aria-label={t('tickets.help')}>?</summary>
          <p>{t(mode === 'tapd' ? 'tickets.tapdHelp' : 'linkedOnlyHelp')}</p>
        </details>
        {actions}
      </div>
    </header>
    <div hidden={mode !== 'tapd'}><TapdItems {...props} openLinks={(id) => {
      setLinkedFilter(id)
      void props.callbacks.loadLinkedCrashes({ offset: 0, text: id })
      navigate('crash')
    }} /></div>
    <div hidden={mode !== 'crash'}><LinkedCrashes {...props} filter={linkedFilter} setFilter={setLinkedFilter} /></div>
  </section>
}
