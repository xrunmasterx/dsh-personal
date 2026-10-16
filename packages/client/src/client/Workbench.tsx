import { CodeArchive } from './CodeArchive.tsx'
/** Personal pages composed around the official sidebar, conversation, details and overlays. */
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
  TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  InvestigationTarget,
  PlanRequest,
  ProfileRecord,
  ReportRef,
  RunId,
  RunRecord,
  WorkbenchInfo,
  RunSummary,
  RunQuery,
  ProfileId,
} from '@xrunmasterx/dsh-personal-api/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AgentDivider } from './AgentDivider.tsx'
import { Badge, date } from './presentation.tsx'
import { Tickets } from './Tickets.tsx'
import { Journal, type JournalActions } from './Journal.tsx'
import { CaseDetails, ProfileDelta, StoragePage } from './Panels.tsx'
import type { WorkbenchClient, WorkbenchData } from './data.ts'
import type { createViewStore, WorkbenchPage } from './view-store.ts'
import { History, HistoryReadingHost } from './History.tsx'
import css from './Workbench.module.css'

/** Plain action callbacks and one renderer-bound observable. */
export type WorkbenchInjected = Pick<
  WorkbenchClient,
  | 'refresh'
  | 'refreshTapd'
  | 'loadLinkedCrashes'
  | 'search'
  | 'reports'
  | 'prepare'
  | 'clearPlan'
  | 'start'
  | 'cancel'
  | 'readReport'
  | 'refreshEvidence'
  | 'generate'
  | 'cancelProfile'
  | 'review'
  | 'publish'
  | 'activate'
  | 'loadRuns'
  | 'readRun'
  | 'inspectIssue'
  | 'closeIssue'
  | 'closeReports'
  | 'readEvidence'
  | 'loadProfile'
  | 'readVersion'
  | 'previewCleanup'
  | 'cleanStorage'
> & JournalActions & { hooks: {
  workbench: ObservableSnapshot<WorkbenchData>
  taskSessions: ObservableSnapshot<SessionListState>
  taskWorkspaces: ObservableSnapshot<WorkspaceSnapshot>
} }

/** Root's four framework shares plus locale and injected callbacks. */
export type WorkbenchProps = PropsRuntime<'root'> &
  PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay'> &
  PropsStore<ReturnType<typeof createViewStore>> &
  PropsLocale<'personal-workbench'> &
  InjectFace<WorkbenchInjected>

type Copy = TranslateNS<'personal-workbench'>
type Actions = Omit<WorkbenchInjected, 'hooks'>
interface PageProps {
  data: WorkbenchData & { info: WorkbenchInfo }
  t: Copy
  callbacks: Actions
  investigate: (target: InvestigationTarget, samples: ReportRef[], previous?: RunRecord) => void
  history: (target: InvestigationTarget | null) => void
}

function live(run: Pick<RunSummary, 'status'>): boolean {
  return ['queued', 'running', 'stopping'].includes(run.status)
}
function reportKey(report: ReportRef): string {
  return `${report.appId}:${report.platformId}:${report.crashHash}`
}
function artifactUrl(runId: RunId, artifactId: string): string {
  return `/api/personal-workbench.artifact?runId=${encodeURIComponent(runId)}&artifactId=${encodeURIComponent(artifactId)}`
}

const NAVIGATION_GROUPS: ReadonlyArray<{
  label: 'navGroup.work' | 'navGroup.growth' | 'navGroup.system' | 'navGroup.sources'
  pages: readonly WorkbenchPage[]
}> = [
  { label: 'navGroup.work', pages: ['board', 'reflection', 'archive', 'code'] },
  { label: 'navGroup.sources', pages: ['tapd', 'runs'] },
  { label: 'navGroup.growth', pages: ['profile'] },
  { label: 'navGroup.system', pages: ['storage', 'chat'] },
]

const NAV_ICON_PATHS: Record<WorkbenchPage, readonly string[]> = {
  code: ['m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18'],
  archive: ['M4 4h16v16H4z', 'M8 8h8M8 12h8M8 16h5'],
  board: ['M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M10 3v18M10 12h11'],
  reflection: ['M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z', 'M12 5v15', 'm15 11 2 2 3-4'],
  tapd: ['M9 4V3h8a3 3 0 0 1 3 3v10', 'M6 6h8l3 4v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z', 'M14 6v4h3', 'M8 13h5M8 17h4'],
  crash: ['M4 12h3l2-5 4 10 2-5h5', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  runs: ['M9 4a6 6 0 1 0 0 12A6 6 0 0 0 9 4Z', 'm13.5 14.5 4 4', 'M19 7h3M19 11h3M20 15h2'],
  profile: ['M5 18a9 9 0 0 1 11-14M20 7a9 9 0 0 1-1 11', 'M12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z', 'M6 20c0-3.5 2.5-6 6-6s6 2.5 6 6a10 10 0 0 1-12 0Z'],
  storage: ['M14 7H6L3 12v6a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-5', 'M3 12h14', 'M19 2.5 20 5 22.5 6 20 7 19 9.5 18 7 15.5 6 18 5Z'],
  chat: ['M7 3h10a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4Z', 'M7 9h10M7 14h10', 'M14 7.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z M10 12.3a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z'],
}

function PageIcon({ page }: { page: WorkbenchPage }) {
  return (
    <svg aria-hidden="true" className={css.navIcon} fill="none" viewBox="0 0 24 24">
      {NAV_ICON_PATHS[page].map((path, index) => {
        const filled = (page === 'profile' && index > 0) || ((page === 'storage' || page === 'chat') && index === 2)
        return <path d={path} key={path} fill={filled ? 'currentColor' : 'none'}
          stroke={filled ? 'none' : undefined} fillRule="evenodd" />
      })}
    </svg>
  )
}

function AgentToggle({ open, onClick, t }: { open: boolean; onClick: () => void; t: Copy }) {
  const label = t(open ? 'agent.collapse' : 'agent.expand')
  return (
    <button type="button" className={css.agentToggle} aria-label={label} title={label}
      aria-expanded={open} onClick={onClick}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M15 4v16" />
        {open && <path d="M15 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3Z" fill="currentColor" opacity="0.2" stroke="none" />}
      </svg>
    </button>
  )
}

function RunsPage({
  data,
  t,
  callbacks,
  investigate,
  history,
  selection,
  setSelection,
}: PageProps & { selection: RunId | null; setSelection: (id: RunId | null) => void }) {
  const run = data.selectedRun?.id === selection ? data.selectedRun : null
  const runs = data.runs
  const query: RunQuery = data.runPage?.query ?? { offset: 0, target: null, text: '', mode: 'all', status: 'all' }
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [search, setSearch] = useState(query.text)
  return (
    <>
      <div className={css.toolbar}>
        <div className={css.rowActions}>
          {run ? (
            <button
              onClick={() => {
                setSelection(null)
              }}
            >
              {t('back')}
            </button>
          ) : (
            <span className={css.meta}>{t('runCount', { count: data.runPage?.total ?? 0 })}</span>
          )}
          {query.target !== null && (
            <button
              onClick={() => {
                history(null)
              }}
            >
              {t('allRuns')}
            </button>
          )}
        </div>
        <button onClick={() => void callbacks.refresh()}>{t('refresh')}</button>
      </div>
      {!selection && (
        <form
          className={css.filters}
          onSubmit={(event) => {
            event.preventDefault()
            void callbacks.loadRuns({ ...query, text: search, offset: 0 })
          }}
        >
          <input
            aria-label={t('filter')}
            placeholder={t('filter')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
            }}
          />
          <select
            aria-label={t('mode')}
            value={query.mode}
            onChange={event =>
              void callbacks.loadRuns({ ...query, mode: event.target.value as RunQuery['mode'], offset: 0 })
            }
          >
            <option value="all">{t('all')}</option>
            <option value="single">{t('single')}</option>
            <option value="dual">{t('dual')}</option>
          </select>
          <select
            aria-label={t('state')}
            value={query.status}
            onChange={event =>
              void callbacks.loadRuns({ ...query, status: event.target.value as RunQuery['status'], offset: 0 })
            }
          >
            <option value="all">{t('all')}</option>
            {(
              [
                'queued',
                'running',
                'stopping',
                'completed',
                'no_evidence',
                'failed',
                'canceled',
                'interrupted',
              ] as const
            ).map(status => (
              <option key={status} value={status}>
                {t(`status.${status}`)}
              </option>
            ))}
          </select>
          <button disabled={data.busy.includes('runs')}>{t('search')}</button>
        </form>
      )}
      {!run && (
        <div className={css.sheet}>
          {runs.length ? (
            <table>
              <thead>
                <tr>
                  <th>{t('title')}</th>
                  <th>{t('mode')}</th>
                  <th>{t('state')}</th>
                  <th>{t('progress')}</th>
                  <th>{t('created')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id}>
                    <td>
                      <button
                        className={css.textButton}
                        onClick={() => {
                          setSelection(run.id)
                        }}
                      >
                        {run.title}
                      </button>
                      <small>{run.id}</small>
                    </td>
                    <td>{t(run.mode)}</td>
                    <td>
                      <Badge active={live(run)}>{t(`status.${run.status}`)}</Badge>
                    </td>
                    <td>
                      {t(`phase.${run.phase}`)} ·{' '}
                      {run.legacyLimitation ? t('unknown') : `${run.completedCases}/${run.totalCases}`}
                    </td>
                    <td>{date(run.createdAt, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className={css.empty}>{t('empty')}</div>
          )}
        </div>
      )}
      {run && (
        <section className={css.section}>
          <div className={css.toolbar}>
            <h2>{run.title}</h2>
            <div className={css.rowActions}>
              {live(run) ? (
                <button
                  disabled={run.status === 'stopping' || data.busy.includes('cancel')}
                  onClick={() => void callbacks.cancel(run.id)}
                >
                  {t(run.status === 'stopping' ? 'status.stopping' : 'stop')}
                </button>
              ) : (
                <button
                  onClick={() => {
                    investigate(run.target, run.samples, run)
                  }}
                >
                  {t('rerun')}
                </button>
              )}
              {['completed', 'no_evidence'].includes(run.status) && (
                <>
                  <button onClick={() => void callbacks.readReport(run.id)}>{t('report')}</button>
                  <a className={css.buttonLink} href={artifactUrl(run.id, 'report')}>
                    {t('download')}
                  </a>
                  {run.artifacts.some(file => file.id === 'result') && (
                    <a className={css.buttonLink} href={artifactUrl(run.id, 'result')}>
                      {t('result')}
                    </a>
                  )}
                  {run.artifacts.some(file => file.id === 'legacy-result') && (
                    <a className={css.buttonLink} href={artifactUrl(run.id, 'legacy-result')}>
                      {t('legacyResult')}
                    </a>
                  )}
                  <a className={css.buttonLink} href={artifactUrl(run.id, 'input')}>
                    {t('input')}
                  </a>
                </>
              )}
              {data.report?.runId === run.id && (
                <button
                  onClick={() => {
                    if (!data.report) return
                    void navigator.clipboard.writeText(data.report.markdown).then(
                      () => {
                        setCopied(true)
                        setCopyError(false)
                      },
                      () => {
                        setCopyError(true)
                      },
                    )
                  }}
                >
                  {t(copied ? 'copied' : 'copyReport')}
                </button>
              )}
            </div>
          </div>
          <CaseDetails data={data} t={t} callbacks={callbacks} run={run} />
          {copyError && <p className={css.warning}>{t('copyFailed')}</p>}
          <p className={css.meta}>
            {t('runId')} · {run.id}
            <br />
            {t('sourceRoot')} · {run.sourceRoot}
          </p>
          {run.error && <p className={css.warning}>{run.error}</p>}
          {run.legacyLimitation && <p className={css.warning}>{run.legacyLimitation}</p>}
          {run.samples.map(sample => (
            <p className={css.meta} key={reportKey(sample)}>
              {sample.appId} · {sample.platformId} · {sample.crashHash} · {sample.version ?? t('unknown')}
            </p>
          ))}
          {data.report?.runId === run.id && (
            <div className={css.report}>
              <MarkdownText
                text={data.report.markdown}
                labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }}
              />
            </div>
          )}
        </section>
      )}
      {!selection && data.runPage && (
        <div className={css.pager}>
          <span>
            {runs.length ? query.offset + 1 : 0}–{query.offset + runs.length} / {data.runPage.total}
          </span>
          <button
            disabled={query.offset === 0 || data.busy.includes('runs')}
            onClick={() =>
              void callbacks.loadRuns({ ...query, offset: Math.max(0, query.offset - data.info.pageSize) })
            }
          >
            {t('previous')}
          </button>
          <button
            disabled={data.runPage.nextOffset === null || data.busy.includes('runs')}
            onClick={() => {
              if (data.runPage?.nextOffset !== null && data.runPage?.nextOffset !== undefined)
                void callbacks.loadRuns({ ...query, offset: data.runPage.nextOffset })
            }}
          >
            {t('next')}
          </button>
        </div>
      )}
    </>
  )
}

function ProfilePage({ data, t, callbacks }: PageProps) {
  const profile = data.profile
  const [correction, setCorrection] = useState<{ id: string; value: string } | null>(null)
  const draft = profile?.drafts.find(draft => draft.id === profile.selectedDraftId)
  const stale = Boolean(
    profile?.evidence &&
      Date.now() - Date.parse(profile.evidenceCheckedAt ?? profile.evidence.createdAt) > data.info.cacheTtlMs,
  )
  const publishedDraft = Boolean(profile?.selectedDraftPublication)
  const pending = draft?.content?.claims.some(
    claim => claim.dimension !== 'growth' && claim.reviewStatus === 'pending',
  )
  const review = (draft: ProfileRecord, claimId: string, action: 'confirm' | 'reject', correction = '') =>
    void callbacks.review({ generationId: draft.id, claimId, expectedRevision: draft.revision, action, correction })
  return (
    <>
      <div className={css.toolbar}>
        <h2>{t('materials')}</h2>
        <div className={css.rowActions}>
          <button disabled={data.busy.includes('evidence')} onClick={() => void callbacks.refreshEvidence()}>
            {t('refreshEvidence')}
          </button>
          <button
            className={css.primary}
            disabled={
              !profile?.evidence ||
              stale ||
              profile.drafts.some(draft => draft.status === 'running' || draft.status === 'stopping') ||
              data.busy.includes('generate')
            }
            onClick={() => profile?.evidence && void callbacks.generate(profile.evidence.id)}
          >
            {t('generate')}
          </button>
        </div>
      </div>
      {stale && <p className={css.warning}>{t('staleEvidence')}</p>}
      {profile?.evidence ? (
        <>
          <p className={css.meta}>
            {t('evidenceCount', { count: profile.evidence.evidence.length })} · {date(profile.evidence.createdAt, t)}
            <br />
            {t('lastChecked')} · {date(profile.evidenceCheckedAt, t)}
          </p>
          <div className={css.coverage}>
            {profile.evidence.coverage.map(item => (
              <div className={css.card} key={item.source}>
                <strong>{t(`source.${item.source}`)}</strong>
                <Badge>{t(`coverage.${item.status}`)}</Badge>
                <p>{t('evidenceCount', { count: item.itemCount })}</p>
                <small>{item.limitation}</small>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className={css.empty}>{t('noEvidence')}</p>
      )}
      <section className={css.section}>
        <h2>{t('published')}</h2>
        {profile?.published ? (
          <div className={css.card}>
            <Badge active>{t('publication', { version: profile.published.version })}</Badge>
            <p>{profile.published.content.summary}</p>
            <small>
              {date(profile.published.publishedAt, t)} · {t('immutable')}
            </small>
          </div>
        ) : (
          <p className={css.meta}>{t('noPublished')}</p>
        )}
      </section>
      <section className={css.section}>
        <div className={css.toolbar}>
          <h2>{t('draft')}</h2>
          {profile?.drafts.length ? (
            <select
              aria-label={t('draft')}
              value={draft?.id}
              onChange={(event) => {
                const id = event.target.value as ProfileId
                void callbacks.loadProfile(id, profile.draftOffset, profile.versionOffset)
                setCorrection(null)
              }}
            >
              {profile.drafts.map(draft => (
                <option key={draft.id} value={draft.id}>
                  {date(draft.createdAt, t)} · {t(`status.${draft.status}`)}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {!draft && <p className={css.meta}>{t('noDraft')}</p>}
        {draft && (
          <>
            <p className={css.meta}>
              {t('draftRevision', { revision: draft.revision })} · {t(`status.${draft.status}`)}
            </p>
            {(draft.status === 'running' || draft.status === 'stopping') && (
              <button
                disabled={draft.status === 'stopping' || data.busy.includes('cancel-profile')}
                onClick={() => void callbacks.cancelProfile(draft.id)}
              >
                {t(draft.status === 'stopping' ? 'status.stopping' : 'stop')}
              </button>
            )}
            {draft.error && <p className={css.warning}>{draft.error}</p>}
            {draft.activity && (
              <p className={css.meta}>
                {t('activity')} · {date(draft.activity.at, t)}
              </p>
            )}
            {draft.content && (
              <ProfileDelta previous={profile?.published?.content ?? null} draft={draft.content} t={t} />
            )}
            {draft.content?.claims.map(claim => (
              <article className={css.card} key={claim.id}>
                <div className={css.toolbar}>
                  <strong>{claim.topic}</strong>
                  <div className={css.rowActions}>
                    <Badge>{t(`assessment.${claim.assessment}`)}</Badge>
                    <Badge active={claim.reviewStatus === 'confirmed'}>{t(`review.${claim.reviewStatus}`)}</Badge>
                  </div>
                </div>
                <p>{claim.statement}</p>
                {claim.dimension === 'growth' && <small>{t('growth')}</small>}
                <details>
                  <summary>
                    {t('evidenceRefs')} · {claim.evidenceRefs.length}
                  </summary>
                  {claim.evidenceRefs.map((id) => {
                    const evidence = draft.content?.evidence.find(item => item.id === id)
                    return (
                      <div key={id} className={css.evidence}>
                        <strong>{evidence?.title ?? id}</strong>
                        <p>{evidence?.summary}</p>
                        {evidence?.url && (
                          <a href={evidence.url} target="_blank" rel="noreferrer">
                            {t('original')}
                          </a>
                        )}
                      </div>
                    )
                  })}
                </details>
                {!publishedDraft && (
                  <div className={css.rowActions}>
                    <button
                      disabled={data.busy.includes('review')}
                      onClick={() => {
                        review(draft, claim.id, 'confirm')
                      }}
                    >
                      {t('confirm')}
                    </button>
                    <button
                      disabled={data.busy.includes('review')}
                      onClick={() => {
                        review(draft, claim.id, 'reject')
                      }}
                    >
                      {t('reject')}
                    </button>
                    <button
                      onClick={() => {
                        setCorrection({ id: claim.id, value: claim.statement })
                      }}
                    >
                      {t('correction')}
                    </button>
                  </div>
                )}
                {correction?.id === claim.id && !publishedDraft && (
                  <div className={css.correction}>
                    <textarea
                      aria-label={t('correction')}
                      maxLength={500}
                      value={correction.value}
                      onChange={(event) => {
                        setCorrection({ id: claim.id, value: event.target.value })
                      }}
                    />
                    <button
                      disabled={!correction.value.trim() || data.busy.includes('review')}
                      onClick={() => {
                        review(draft, claim.id, 'confirm', correction.value)
                        setCorrection(null)
                      }}
                    >
                      {t('saveCorrection')}
                    </button>
                  </div>
                )}
              </article>
            ))}
            {draft.content && !publishedDraft && (
              <div className={css.publish}>
                <p className={css.meta}>{t('pendingClaims')}</p>
                <button
                  className={css.primary}
                  disabled={pending || data.busy.includes('publish') || data.busy.includes('review')}
                  onClick={() => void callbacks.publish({ generationId: draft.id, expectedRevision: draft.revision })}
                >
                  {t('publish')}
                </button>
              </div>
            )}
            {draft.content?.currentFocus.length ? (
              <>
                <h3>{t('focus')}</h3>
                {draft.content.currentFocus.map(item => (
                  <details key={item.id}>
                    <summary>
                      <strong>{item.topic}</strong> · {item.summary}
                    </summary>
                    {item.evidenceRefs.map((id) => {
                      const evidence = draft.content?.evidence.find(fact => fact.id === id)
                      return (
                        <p key={id}>
                          {evidence?.summary ?? id}
                          {evidence?.url && (
                            <>
                              {' '}
                              ·{' '}
                              <a href={evidence.url} target="_blank" rel="noreferrer">
                                {t('original')}
                              </a>
                            </>
                          )}
                        </p>
                      )
                    })}
                  </details>
                ))}
              </>
            ) : null}
          </>
        )}
      </section>
      {profile && profile.draftTotal > data.info.pageSize && (
        <div className={css.pager}>
          <button
            disabled={profile.draftOffset === 0}
            onClick={() => {
              void callbacks.loadProfile(
                null,
                Math.max(0, profile.draftOffset - data.info.pageSize),
                profile.versionOffset,
              )
            }}
          >
            {t('previous')}
          </button>
          <button
            disabled={profile.nextDraftOffset === null}
            onClick={() => {
              if (profile.nextDraftOffset !== null)
                void callbacks.loadProfile(null, profile.nextDraftOffset, profile.versionOffset)
            }}
          >
            {t('next')}
          </button>
        </div>
      )}
      {!!profile?.versions.length && (
        <section className={css.section}>
          <h2>{t('versions')}</h2>
          {profile.versions.map(version => (
            <details
              key={version.id}
              name="personal-profile-version"
              className={css.card}
              onToggle={(event) => {
                if (event.currentTarget.open) void callbacks.readVersion(version.id)
              }}
            >
              <summary>
                {t('publication', { version: version.version })} · {date(version.publishedAt, t)}
              </summary>
              {data.publication?.id === version.id &&
                data.publication.content.claims.map(claim => (
                  <p key={claim.id}>
                    <strong>{claim.topic}</strong> · {claim.statement}
                  </p>
                ))}
            </details>
          ))}
          {profile.versionTotal > data.info.pageSize && (
            <div className={css.pager}>
              <button
                disabled={profile.versionOffset === 0}
                onClick={() =>
                  void callbacks.loadProfile(
                    profile.selectedDraftId,
                    profile.draftOffset,
                    Math.max(0, profile.versionOffset - data.info.pageSize),
                  )
                }
              >
                {t('previous')}
              </button>
              <button
                disabled={profile.nextVersionOffset === null}
                onClick={() => {
                  if (profile.nextVersionOffset !== null)
                    void callbacks.loadProfile(profile.selectedDraftId, profile.draftOffset, profile.nextVersionOffset)
                }}
              >
                {t('next')}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}

/** Render workbench pages while retaining every official shell slot. */
export function Workbench(props: WorkbenchProps) {
  const { useStore, actions, useWorkbench, useTaskSessions, useTaskWorkspaces, renderSlot, t } = props
  const view = useStore(state => state)
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [frameWidth, setFrameWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    if (!frame) return
    const measure = () => { if (frame.clientWidth > 0) setFrameWidth(frame.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => { observer.disconnect() }
  }, [frame])
  useEffect(() => {
    try {
      localStorage.setItem('personal-workbench.sidebar-collapsed', String(view.sidebarCollapsed))
    } catch {
      // Storage denial keeps navigation usable with this mounted preference.
    }
  }, [view.sidebarCollapsed])
  const data = useWorkbench(state => state)
  const taskSessions = useTaskSessions(state => state)
  const archivedSessionIds = useTaskWorkspaces(state => state.archivedSessionIds)
  const [taskOpen, setTaskOpen] = useState(false)
  const onTaskDetail = useCallback((open: boolean) => { setTaskOpen(open) }, [])
  const [readingHost, setReadingHost] = useState<HTMLDivElement | null>(null)
  const [dialog, setDialog] = useState<PlanRequest | null>(null)
  const [selectedRun, setSelectedRun] = useState<RunId | null>(null)
  const agentOpen = view.agentOpen
  const setAgentOpen = actions.setAgentOpen
  useEffect(() => {
    try {
      localStorage.setItem('personal-workbench.agent-open', String(view.agentOpen))
      localStorage.setItem('personal-workbench.agent-width', String(view.agentWidth))
    } catch {
      // Storage denial leaves the mounted layout preference usable.
    }
  }, [view.agentOpen, view.agentWidth])
  const [agentError, setAgentError] = useState('')
  const assist = useCallback(async (text: string) => {
    setAgentOpen(true); setAgentError('')
    try { await props.assist(text) } catch (error) { setAgentError(error instanceof Error ? error.message : String(error)); throw error }
  }, [props.assist, setAgentOpen])
  const openTaskSession = useCallback<JournalActions['openTaskSession']>(async (session, taskId) => {
    setAgentOpen(true)
    await props.openTaskSession(session, taskId)
  }, [props.openTaskSession, setAgentOpen])
  const journalApi = useMemo<JournalActions>(() => ({
    ...(props.reviews ? { reviews: props.reviews } : {}),
    ...(props.code ? { code: props.code } : {}),
    ...(props.history ? { history: props.history } : {}),
    journalUploadImage: props.journalUploadImage, journalReadImage: props.journalReadImage,
    polishBrief: props.polishBrief,
    journalQuery: props.journalQuery, journalWrite: props.journalWrite, journalHistory: props.journalHistory,
    journalActivity: props.journalActivity, journalWeek: props.journalWeek, journalReport: props.journalReport,
    journalSaveReport: props.journalSaveReport, journalEvent: props.journalEvent, assist, openTaskSession,
    beginTaskSession: props.beginTaskSession,
    beginBoardSession: props.beginBoardSession,
    archiveTaskSession: props.archiveTaskSession,
  }), [
    props.journalUploadImage, props.journalReadImage,
    props.reviews, props.code, props.history, props.polishBrief, props.journalQuery, props.journalWrite, props.journalHistory,
    props.journalActivity, props.journalWeek,
    props.journalReport, props.journalSaveReport, props.journalEvent, assist, openTaskSession,
    props.beginTaskSession, props.beginBoardSession, props.archiveTaskSession,
  ])
  const journalPage =
    view.page === 'board' || view.page === 'reflection'
      ? view.page : null
  useEffect(() => {
    props.activate(view.page)
  }, [view.page, props.activate])
  const openInvestigation = (target: InvestigationTarget, samples: ReportRef[], previous?: RunRecord) => {
    props.clearPlan()
    setDialog({
      target,
      samples,
      mode: previous?.mode ?? 'single',
      additionalContext: previous?.additionalContext ?? '',
    })
  }
  const history = (target: InvestigationTarget | null) => {
    void props.loadRuns({ target, offset: 0, text: '', mode: 'all', status: 'all' })
    setSelectedRun(null)
    actions.navigate('runs')
  }
  const selectRun = (id: RunId | null) => {
    setSelectedRun(id)
    if (id) void props.readRun(id)
  }
  const pageProps: PageProps | null = data.info
    ? {
      data: { ...data, info: data.info }, t,
      callbacks: { ...props, assist: text => assist(text).catch(() => undefined) },
      investigate: openInvestigation, history,
    }
    : null
  const ticketsPage = view.page === 'tapd' || view.page === 'crash'
  const activeRuns = data.changes?.activeRuns.length ?? 0
  return (
    <div
      ref={setFrame}
      className={css.frame}
      data-page={view.page} data-task-open={taskOpen} data-sidebar-collapsed={view.sidebarCollapsed}
      style={{
        '--pw-sidebar-width': view.sidebarCollapsed ? '64px' : '200px',
        '--pw-agent-width': `${view.agentWidth}px`,
        gridTemplateColumns: `var(--pw-sidebar-width) minmax(0, 1fr) ${view.page !== 'chat' && agentOpen ? `min(${view.agentWidth}px, 45%)` : view.page === 'chat' && view.detailsOpen ? '380px' : '0px'}`,
      } as import('react').CSSProperties}
    >
      <aside className={css.sidebar}>
        <div className={css.brand}>
          <span className={css.brandMark} aria-hidden="true">
            <svg fill="none" viewBox="0 0 36 36">
              <path d="M11 27V15a7 7 0 1 1 7 7h-7" />
            </svg>
          </span>
          <span className={css.brandCopy}>
            <strong>{t('brand')}</strong>
            <small>{t('brand.product')}</small>
          </span>
          <button className={css.sidebarToggle} aria-expanded={!view.sidebarCollapsed}
            aria-label={t(view.sidebarCollapsed ? 'nav.expand' : 'nav.collapse')}
            title={t(view.sidebarCollapsed ? 'nav.expand' : 'nav.collapse')}
            onClick={() => { actions.toggleSidebar() }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" />
            </svg>
          </button>
        </div>
        <nav className={css.navigation} aria-label={t('brand')}>
          {NAVIGATION_GROUPS.map(group => (
            <div className={css.navGroup} key={group.label}>
              <p>{t(group.label)}</p>
              {group.pages.map(page => (
                <button
                  key={page}
                  aria-current={view.page === page || (page === 'tapd' && view.page === 'crash') ? 'page' : undefined}
                  title={t(`nav.${page}`)}
                  onClick={() => {
                    if (page === 'runs') history(null)
                    else actions.navigate(page)
                  }}
                >
                  <PageIcon page={page} />
                  <span>{t(`nav.${page}`)}</span>
                  {page === 'runs' && Boolean(activeRuns) && <span className={css.dot} />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className={css.officialSidebar} data-visible={view.page === 'chat'}>
          {view.page === 'chat' && renderSlot('sidebar', { collapsed: view.sidebarCollapsed, width: view.sidebarCollapsed ? 64 : 200 })}
        </div>
        <div className={css.space}>
          <span aria-hidden="true" />
          {data.info?.projectName ?? t('configured')}
        </div>
      </aside>
      <main className={css.main} data-task-detail={taskOpen}>
        <HistoryReadingHost.Provider value={readingHost}>
          <div className={css.conversation} data-visible={view.page === 'chat'}>
            {view.page === 'chat' && renderSlot('main', {}, { entryKey: view.panelInfo.activePanelId ?? 'conversation' })}
          </div>
          {view.page !== 'chat' && (
            <div className={css.content} data-work-scroll>
              <div className={css.page}>
                {!journalPage && !ticketsPage && <header className={`${css.header} ${['archive', 'code'].includes(view.page) ? css.archiveHeader : ''}`}>
                  <div className={css.headerCopy}>
                    <p className={css.eyebrow}>{data.info?.projectName}</p>
                    <h1>{t(`nav.${view.page}`)}</h1>
                    <p>
                      {t(
                        view.page === 'code' ? 'code.hint' : view.page === 'archive'
                          ? 'history.hint'
                          : view.page === 'runs'
                            ? 'runHelp'
                            : view.page === 'storage'
                              ? 'storageHelp'
                              : 'profileHelp',
                      )}
                    </p>
                  </div>
                  <div className={css.headerActions}>
                    {activeRuns ? (
                      <button
                        className={css.activityPill}
                        onClick={() => {
                          history(null)
                        }}
                      >
                        <span aria-hidden="true" />
                        {t('activeInvestigations', { count: activeRuns })}
                      </button>
                    ) : (
                      <span className={css.readyPill}>
                        <span aria-hidden="true" />
                        {t('workspaceReady')}
                      </span>
                    )}
                    <AgentToggle open={agentOpen} t={t} onClick={() => { setAgentOpen(!agentOpen) }} />
                  </div>
                </header>}
                {agentError && <p className={css.warning} role="alert">{agentError}</p>}
                {data.error && (
                  <div className={css.warning} role="alert">
                    <strong>{t('error')}</strong>
                    <p>{data.error}</p>
                  </div>
                )}
                {!pageProps ? (
                  <div className={css.empty}>
                    {t('loading')}
                    <button onClick={() => void props.refresh()}>{t('retry')}</button>
                  </div>
                ) : journalPage ? (
                  <Journal key={journalPage} page={journalPage} sessions={taskSessions}
                    archivedSessionIds={archivedSessionIds} onTaskDetail={onTaskDetail}
                    api={journalApi} t={t} pollIntervalMs={pageProps.data.info.pollIntervalMs}
                    boardActions={<>
                      {activeRuns > 0 && <button onClick={() => { history(null) }}>{t('activeInvestigations', { count: activeRuns })}</button>}
                      <AgentToggle open={agentOpen} t={t} onClick={() => { setAgentOpen(!agentOpen) }} />
                    </>} />
                ) : view.page === 'tapd' || view.page === 'crash' ? (
                  <Tickets {...pageProps} mode={view.page} navigate={actions.navigate}
                    actions={<AgentToggle open={agentOpen} t={t} onClick={() => { setAgentOpen(!agentOpen) }} />} />
                ) : view.page === 'runs' ? (
                  <RunsPage {...pageProps} selection={selectedRun} setSelection={selectRun} />
                ) : view.page === 'code' && props.code ? (
                  <CodeArchive api={props.code} t={t} pollIntervalMs={pageProps.data.info.pollIntervalMs} />
                ) : view.page === 'archive' && props.history ? (
                  <History api={props.history} t={t} pollIntervalMs={pageProps.data.info.pollIntervalMs} />
                ) : view.page === 'storage' ? (
                  <StoragePage {...pageProps} />
                ) : (
                  <ProfilePage {...pageProps} />
                )}
              </div>
            </div>
          )}
        </HistoryReadingHost.Provider>
        <div className={css.readingHost} ref={setReadingHost} />
      </main>
      <div className={css.details}>
        {view.page !== 'chat' && agentOpen && <AgentDivider width={view.agentWidth} onChange={actions.setAgentWidth} label={t('layout.agentWidth')} /> }
        {view.page !== 'chat' && agentOpen && <div className={css.journalAgent}><div className={css.agentOverlayToggle}><AgentToggle open={agentOpen} t={t} onClick={() => { setAgentOpen(false) }} /></div>{renderSlot('main', {}, { entryKey: 'conversation' })}</div>}

      </div>
      <div className={css.rightbarHost}>{renderSlot('rightbar', { width: frameWidth >= 700 ? Math.min(380, frameWidth - 400) : 0, viewportWidth: frameWidth, canShow: frameWidth >= 700 })}</div>
      <div className={css.overlay}>{(view.page === 'chat' || agentOpen) && renderSlot('shell.overlay', {})}</div>
      {dialog && (
        <div className={css.modalLayer}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="personal-investigation-title"
            className={css.dialog}
          >
            <div className={css.toolbar}>
              <h2 id="personal-investigation-title">{t('investigate')}</h2>
              <button
                disabled={data.busy.includes('start')}
                onClick={() => {
                  props.clearPlan()
                  setDialog(null)
                }}
              >
                {t('close')}
              </button>
            </div>
            {!data.plan ? (
              <>
                <fieldset disabled={data.busy.includes('plan')}>
                  <legend>{t('mode')}</legend>
                  {(['single', 'dual'] as const).map(mode => (
                    <label className={css.mode} key={mode}>
                      <input
                        type="radio"
                        name="investigation-mode"
                        value={mode}
                        checked={dialog.mode === mode}
                        onChange={() => {
                          setDialog({ ...dialog, mode })
                        }}
                      />
                      <span>
                        <strong>{t(mode)}</strong>
                        <small>{t(mode === 'single' ? 'singleHelp' : 'dualHelp')}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <label className={css.context}>
                  {t('context')}
                  <textarea
                    maxLength={20000}
                    value={dialog.additionalContext}
                    onChange={(event) => {
                      setDialog({ ...dialog, additionalContext: event.target.value })
                    }}
                  />
                </label>
                <button
                  className={css.primary}
                  disabled={data.busy.includes('plan')}
                  onClick={() => void props.prepare(dialog)}
                >
                  {t(data.busy.includes('plan') ? 'preparing' : 'preview')}
                </button>
              </>
            ) : (
              <>
                <h3>{data.plan.title}</h3>
                <p>
                  {t(data.plan.mode)} · {data.info?.investigationModel}
                </p>
                <p className={css.meta}>
                  {t('sourceRoot')} · {data.plan.sourceRoot}
                </p>
                <p>{t('planHelp')}</p>
                {data.plan.samples.length ? (
                  data.plan.samples.map(sample => (
                    <div className={css.card} key={reportKey(sample)}>
                      <code>{sample.crashHash}</code>
                      <small>
                        {sample.appId} · {sample.platformId} · {sample.version ?? t('unknown')}
                      </small>
                    </div>
                  ))
                ) : (
                  <p>{t('ticketOnly')}</p>
                )}
                <details>
                  <summary>{t('limitations')}</summary>
                  {data.plan.notes.map((note, index) => (
                    <p key={index}>{note}</p>
                  ))}
                </details>
                <div className={css.rowActions}>
                  <button
                    disabled={data.busy.includes('start')}
                    onClick={() => {
                      props.clearPlan()
                    }}
                  >
                    {t('back')}
                  </button>
                  <button
                    className={css.primary}
                    disabled={data.busy.includes('start')}
                    onClick={() => {
                      const plan = data.plan
                      if (!plan) return
                      void props.start(plan.id).then((run) => {
                        if (run) {
                          setDialog(null)
                          history(null)
                          selectRun(run.id)
                        }
                      })
                    }}
                  >
                    {t(data.busy.includes('start') ? 'starting' : 'start')}
                  </button>
                </div>
              </>
            )}
            {data.error && (
              <p className={css.warning} role="alert">
                {data.error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
