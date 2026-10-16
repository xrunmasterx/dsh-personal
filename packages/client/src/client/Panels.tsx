/** On-demand details and storage controls for the Personal workbench. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PersonalProfileContent, RunRecord } from '@xrunmasterx/dsh-personal-api/client'
import { useState } from 'react'
import type { WorkbenchClient, WorkbenchData } from './data.ts'
import css from './Workbench.module.css'

type Copy = TranslateNS<'personal-workbench'>
interface Props {
  data: WorkbenchData
  t: Copy
  callbacks: Pick<WorkbenchClient, 'closeIssue' | 'readEvidence' | 'previewCleanup' | 'cleanStorage'>
}

function bytes(value: number, t: Copy): string {
  if (value >= 1_073_741_824) return t('bytesGiB', { value: (value / 1_073_741_824).toFixed(2) })
  if (value >= 1_048_576) return t('bytesMiB', { value: (value / 1_048_576).toFixed(2) })
  if (value >= 1024) return t('bytesKiB', { value: (value / 1024).toFixed(1) })
  return t('bytesB', { value })
}

/**
 * Display Issue scope, trend limitations and verified local ticket links.
 * @param props - selected source details and read-only actions.
 * @returns the selected Issue panel, or no panel.
 */
export function IssueDetails({ data, t, callbacks }: Props) {
  const detail = data.issueDetails
  if (!detail) return null
  const maximum = Math.max(1, ...detail.trend.map(point => point.reports ?? 0))
  return (
    <section className={css.section}>
      <div className={css.toolbar}>
        <h2>{detail.issue?.title ?? detail.issueId}</h2>
        <button
          onClick={() => {
            callbacks.closeIssue()
          }}
        >
          {t('close')}
        </button>
      </div>
      <p className={css.meta}>
        {detail.query.appId} · {detail.query.platformId} · {detail.issueId} ·{' '}
        {new Date(detail.fetchedAt).toLocaleString()}
      </p>
      <p>{detail.issue?.message}</p>
      {detail.issue?.stack && <pre className={css.evidenceText}>{detail.issue.stack}</pre>}
      <h3>{t('trend')}</h3>
      <p className={css.meta}>
        {t('trendScope')} · {detail.trendTimeZone} · {detail.query.version || t('all')}
      </p>
      {detail.trendIgnoresKeyword && <p className={css.warning}>{t('trendKeyword')}</p>}
      {detail.trendError ? (
        <p className={css.warning}>{detail.trendError}</p>
      ) : detail.trend.length ? (
        <div className={css.sheet}>
          <table>
            <thead>
              <tr>
                <th>{t('date')}</th>
                <th>{t('reports')}</th>
                <th>{t('devices')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.trend.map(point => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>
                    <div className={css.trendBar} style={{ width: `${(100 * (point.reports ?? 0)) / maximum}%` }} />
                    {point.reports ?? t('unknown')}
                  </td>
                  <td>{point.devices ?? t('unknown')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t('empty')}</p>
      )}
      <h3>{t('linkedTapd')}</h3>
      {detail.tapdLinks.length ? (
        detail.tapdLinks.map(link => (
          <p key={link.url}>
            <a href={link.url} target="_blank" rel="noreferrer">
              {link.title}
            </a>
          </p>
        ))
      ) : (
        <p className={css.meta}>{t('noKnownLinks')}</p>
      )}
    </section>
  )
}

/**
 * Show live progress, source versions and independently analyzed Case evidence.
 * @param props - authoritative run and any requested result or evidence window.
 * @returns execution and Case detail panels.
 */
export function CaseDetails({ data, t, callbacks, run }: Props & { run: RunRecord }) {
  const result = data.result?.runId === run.id ? data.result.content : null
  const evidence = data.evidence?.runId === run.id ? data.evidence.preview : null
  return (
    <>
      <p className={css.runProgress}>
        {t(`status.${run.status}`)} · {t(`phase.${run.phase}`)} · {run.completedCases}/{run.totalCases}
      </p>
      {run.activity && (
        <p className={css.meta}>
          {t('activity')} · {t(`activity.${run.activity.message}`)} · {new Date(run.activity.at).toLocaleTimeString()}
        </p>
      )}
      {!!run.timeline?.length && (
        <details>
          <summary>{t('timeline')}</summary>
          <ol className={css.timeline}>
            {run.timeline.map((item, index) => (
              <li key={index}>
                {new Date(item.at).toLocaleTimeString()} · {t(`phase.${item.phase}`)} · {item.completedCases}/
                {run.totalCases}
              </li>
            ))}
          </ol>
        </details>
      )}
      {run.provenance && (
        <details>
          <summary>{t('sourceVersions')}</summary>
          <p>
            {t('harnessName')} {run.provenance.start.harnessVersion} ·{' '}
            {new Date(run.provenance.start.capturedAt).toLocaleString()}
          </p>
          {run.provenance.start.repositories.map(repo => (
            <div className={css.card} key={repo.path}>
              <strong>{repo.name}</strong>
              <p className={css.meta}>{repo.path}</p>
              <p>
                {repo.head ?? t('unknown')} · {repo.ref}={repo.refSha ?? t('unknown')}
              </p>
              <p>
                {t('localChanges', { count: repo.trackedChanges })} · {t('lastFetch')}{' '}
                {repo.fetchedAt ? new Date(repo.fetchedAt).toLocaleString() : t('unknown')}
              </p>
              {repo.error && <p className={css.warning}>{repo.error}</p>}
            </div>
          ))}
          <p className={run.provenance.changed ? css.warning : css.meta}>
            {t(run.provenance.changed ? 'sourceChanged' : 'sourceMutable')}
          </p>
        </details>
      )}
      {result && (
        <section>
          <h3>{t('cases')}</h3>
          {result.cases.map(bundle => (
            <details className={css.card} key={bundle.caseInput.case.id}>
              <summary>
                {bundle.investigation.conclusionLevel} · {bundle.investigation.oneSentenceConclusion}
              </summary>
              <p className={css.meta}>{bundle.caseInput.case.id}</p>
              <p>{bundle.investigation.summary}</p>
              {bundle.validationWarnings.map((warning, index) => (
                <p key={index} className={css.warning}>
                  {warning}
                </p>
              ))}
              {bundle.mechanism && (
                <details>
                  <summary>{t('handoff')}</summary>
                  <p>{bundle.mechanism.oneSentenceConclusion}</p>
                  <p>{bundle.mechanism.summary}</p>
                  <p>{bundle.mechanism.violatedContract}</p>
                  <ol>
                    {bundle.mechanism.causalChain.map((step, index) => (
                      <li key={index}>
                        {step.statement}
                        <small>{step.evidenceRefs.join(' · ')}</small>
                      </li>
                    ))}
                  </ol>
                  {bundle.mechanism.limitations.map((line, index) => (
                    <p className={css.meta} key={index}>
                      {line}
                    </p>
                  ))}
                </details>
              )}
              <h4>{t('evidenceFiles')}</h4>
              {bundle.caseInput.evidenceFiles.map(file => (
                <p key={file.evidenceId}>
                  <button
                    disabled={data.busy.includes('file')}
                    onClick={() => void callbacks.readEvidence(run.id, file.evidenceId, 0)}
                  >
                    {file.name}
                  </button>
                  <small>{bytes(file.sizeBytes, t)}</small>
                </p>
              ))}
              {bundle.investigation.limitations.map((line, index) => (
                <p className={css.meta} key={index}>
                  {line}
                </p>
              ))}
            </details>
          ))}
        </section>
      )}
      {evidence && (
        <section className={css.card}>
          <h3>{evidence.name}</h3>
          <p className={css.meta}>
            {t('verifiedFile')} · {bytes(evidence.totalBytes, t)}
          </p>
          <pre className={css.evidenceText}>{evidence.content}</pre>
          {evidence.nextOffset !== null && (
            <button
              disabled={data.busy.includes('file')}
              onClick={() => {
                if (evidence.nextOffset !== null) void callbacks.readEvidence(run.id, evidence.id, evidence.nextOffset)
              }}
            >
              {t('next')}
            </button>
          )}
        </section>
      )}
      {run.artifacts.some(file => file.id !== 'report' && file.id !== 'result') && (
        <details>
          <summary>{t('diagnostics')}</summary>
          {run.artifacts
            .filter(file => file.id !== 'report' && file.id !== 'result')
            .map(file => (
              <p key={file.id}>
                <a
                  href={`/api/personal-workbench.artifact?runId=${encodeURIComponent(run.id)}&artifactId=${encodeURIComponent(file.id)}`}
                >
                  {file.relativePath}
                </a>{' '}
                · {bytes(file.sizeBytes, t)}
              </p>
            ))}
        </details>
      )}
    </>
  )
}

/**
 * Compare proposed statements with the current immutable publication.
 * @param props - previous publication, selected draft and localized copy.
 * @returns additions, substantive changes and removals before publication.
 */
export function ProfileDelta({
  previous,
  draft,
  t,
}: {
  previous: PersonalProfileContent | null
  draft: PersonalProfileContent
  t: Copy
}) {
  const old = new Map((previous?.claims ?? []).map(claim => [claim.id, claim]))
  const current = new Map(
    draft.claims.filter(claim => claim.reviewStatus !== 'rejected').map(claim => [claim.id, claim]),
  )
  const same = (a: (typeof draft.claims)[number], b: (typeof draft.claims)[number]) =>
    a.statement === b.statement &&
    a.assessment === b.assessment &&
    a.confidence === b.confidence &&
    JSON.stringify([...a.evidenceRefs].sort()) === JSON.stringify([...b.evidenceRefs].sort())
  const added = [...current.values()].filter(claim => !old.has(claim.id))
  const changed = [...current.values()].flatMap((claim) => {
    const previous = old.get(claim.id)
    return previous && !same(claim, previous) ? [{ claim, previous }] : []
  })
  const removed = [...old.values()].filter(claim => !current.has(claim.id))
  return (
    <section className={css.card}>
      <h3>{t('profileDelta')}</h3>
      <p>{t('deltaCounts', { added: added.length, changed: changed.length, removed: removed.length })}</p>
      {added.map(claim => (
        <p key={claim.id}>
          <strong>
            {t('added')} · {claim.topic}
          </strong>
          <br />
          {claim.statement}
        </p>
      ))}
      {changed.map(({ claim, previous }) => (
        <div key={claim.id}>
          <strong>
            {t('changed')} · {claim.topic}
          </strong>
          <p className={css.meta}>
            <del>{previous.statement}</del>
          </p>
          <p>{claim.statement}</p>
        </div>
      ))}
      {removed.map(claim => (
        <p key={claim.id}>
          <strong>
            {t('removed')} · {claim.topic}
          </strong>
          <br />
          <del>{claim.statement}</del>
        </p>
      ))}
    </section>
  )
}

/**
 * Present measured use and an explicit two-step cleanup that protects reviewed records.
 * @param props - storage facts and preview-bound cleanup actions.
 * @returns storage inventory and cleanup controls.
 */
export function StoragePage({ data, t, callbacks }: Props) {
  const [includeHistory, setIncludeHistory] = useState(false)
  const usage = data.storage
  const preview = data.cleanup
  return (
    <>
      {usage && (
        <>
          <div className={css.coverage}>
            <div className={css.card}>
              <strong>{t('storageUsed')}</strong>
              <p>
                {bytes(usage.totalBytes, t)} / {bytes(usage.limitBytes, t)}
              </p>
            </div>
            <div className={css.card}>
              <strong>{t('diskFree')}</strong>
              <p>{bytes(usage.freeBytes, t)}</p>
            </div>
            <div className={css.card}>
              <strong>{t('runBudget')}</strong>
              <p>{bytes(usage.maxRunBytes, t)}</p>
            </div>
          </div>
          <div className={css.sheet}>
            <table>
              <thead>
                <tr>
                  <th>{t('category')}</th>
                  <th>{t('files')}</th>
                  <th>{t('size')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.groups.map(group => (
                  <tr key={group.name}>
                    <td>{group.name === 'artifacts' ? t('storageArtifacts') : group.name === 'profiles' ? t('storageProfiles')
                      : group.name === 'legacy' ? t('storageLegacy') : group.name === '.trash' ? t('storageTrash') : group.name}</td>
                    <td>{group.files}</td>
                    <td>{bytes(group.bytes, t)}</td>
                  </tr>
                ))}
                <tr>
                  <td>{t('records')}</td>
                  <td>—</td>
                  <td>{bytes(usage.recordBytes, t)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className={css.meta}>{t('cleanupPolicy')}</p>
      {usage && (
        <p className={css.meta}>
          {t('retentionPolicy', {
            temporary: usage.retention.temporaryRetentionHours,
            snapshot: usage.retention.snapshotRetentionDays,
            draft: usage.retention.draftRetentionDays,
            run: usage.retention.runRetentionDays,
          })}
        </p>
      )}
      <label className={css.mode}>
        <input
          type="checkbox"
          checked={includeHistory}
          onChange={(event) => {
            setIncludeHistory(event.target.checked)
          }}
        />
        {t('includeHistory')}
      </label>
      <button
        disabled={data.busy.includes('cleanup-preview') || data.busy.includes('cleanup')}
        onClick={() => void callbacks.previewCleanup(includeHistory)}
      >
        {t('cleanupPreview')}
      </button>
      {preview && (
        <section className={css.section}>
          <p>
            {t('cleanupCounts', { count: preview.candidates.length })} · {bytes(preview.recoverableBytes, t)}
          </p>
          <p className={css.meta}>
            {t('protectedCounts', {
              runs: preview.protectedRuns,
              snapshots: preview.protectedSnapshots,
              publications: preview.publications,
            })}
          </p>
          <div className={css.sheet}>
            <table>
              <thead>
                <tr>
                  <th>{t('title')}</th>
                  <th>{t('reason')}</th>
                  <th>{t('size')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.candidates.map(item => (
                  <tr key={`${item.kind}:${item.id}`}>
                    <td>{item.label}</td>
                    <td>{item.reason}</td>
                    <td>{bytes(item.bytes, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className={css.primary}
            disabled={
              !preview.candidates.length || preview.includeHistory !== includeHistory || data.busy.includes('cleanup')
            }
            onClick={() => void callbacks.cleanStorage(preview.token, includeHistory)}
          >
            {t('cleanupApply')}
          </button>
        </section>
      )}
      {data.cleaned && (
        <p role="status">
          {t('cleanupDone', { count: data.cleaned.removed })} · {bytes(data.cleaned.recoveredBytes, t)}
        </p>
      )}
    </>
  )
}
