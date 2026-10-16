/** Read-only code evidence shared by archive and task details. */
import { useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodePage } from '@xrunmasterx/dsh-personal-host/client'
import css from './History.module.css'
import codeCss from './CodeArchive.module.css'

/** Host-owned archive commands shared with task evidence views. */
export interface CodeActions {
  interval(): number
  list(offset: number, taskId?: string): Promise<CodePage>
  sync(retry: boolean): Promise<void>
}
/**
 * Display analyzed commits without starting model work on navigation.
 * @param props Archive service, locale, polling interval and optional task.
 * @returns Paged source-linked summaries.
 */
export function CodeArchive({ api, t, pollIntervalMs, taskId }: {
  api: CodeActions
  t: TranslateNS<'personal-workbench'>
  pollIntervalMs: number
  taskId?: string
}) {
  const [page, setPage] = useState<CodePage | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try { const result = await api.list(offset, taskId); if (active) { setPage(result); setError('') } }
      catch (e) { if (active) setError(String(e)) }
      finally { if (active) timer = setTimeout(() => { void read() }, pollIntervalMs) }
    }
    void read()
    return () => { active = false; clearTimeout(timer) }
  }, [api, offset, taskId, pollIntervalMs, refresh])
  const sync = (retry: boolean) => { void api.sync(retry).then(() => { setRefresh(n => n + 1) }, (e: unknown) => { setError(String(e)) }) }
  return <section className={`${css.panel} ${css.archive} ${codeCss.archive}`} aria-label={t('code.title')}>
    <div className={css.toolbar}>{taskId && <h3>{t('code.title')}</h3>}
      {!taskId && <><button disabled={page?.running} onClick={() => { sync(false) }}>{t('history.sync')}</button>
        <button disabled={page?.running} onClick={() => { sync(true) }}>{t('code.retry')}</button></>}
    </div>
    {error && <p className={css.error} role="alert">{error}</p>}
    {page?.error && <details><summary className={css.error}>{t('code.failed')}</summary><p className={css.error}>{page.error}</p></details>}
    {!page ? <p>{t('history.loading')}</p> : <>
      {!taskId && <p className={css.meta}>{page.running ? t('code.running') : t('code.idle')} · {page.lastScan ? new Date(page.lastScan).toLocaleString() : t('code.never')}</p>}
      {page.items.length === 0 && <p className={css.meta}>{t('code.empty')}</p>}
      {page.items.map((record) => {
        const summary = taskId ? record.analysis?.matches.find(m => m.taskId === taskId)?.summary : record.analysis?.summary
        return <article className={css.card} key={record.id}>
          <h3><a href={record.url} target="_blank" rel="noreferrer">{record.title}</a></h3>
          <p className={css.meta}>{record.stageEvents.length ? t(`code.${record.stage}`) : t('code.stagePending')} · {record.author} · {new Date(record.committedAt).toLocaleString()}</p>
          {summary ? <details>
            <summary className={`${css.summary} ${codeCss.preview}`}><span className={css.preview}>{summary.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\s+/g, ' ')}</span></summary>
            <MarkdownText labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} text={summary} />
          </details> : <p>{t('code.pending')}</p>}
          {record.error && <details><summary className={css.error}>{t('code.failed')}</summary><p className={css.error}>{record.error}</p></details>}
          <details><summary>{t('code.records')} · {record.commits.length}</summary>
            {record.commits.map(commit => <div key={commit.id}>
              <p><a href={commit.url} target="_blank" rel="noreferrer">{commit.sha.slice(0, 8)} · {commit.title}</a></p>
              <p className={css.meta}>{new Date(commit.committedAt).toLocaleString()} · {t(`code.${commit.stage}`)}</p>
              <details><summary>{t('code.evidence')}</summary><p className={css.summary}>{commit.branches.join(' · ')}</p>
                {commit.stageEvents.map((event, i) => <p key={i}>{new Date(event.observedAt).toLocaleString()} · {t(`code.${event.stage}`)}</p>)}
                {commit.analysis && <MarkdownText labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} text={commit.analysis.summary} />}
                {commit.diffExpired && <p>{t('code.expired')}</p>}
              </details>
            </div>)}
          </details>
        </article>
      })}
      <div className={css.toolbar}><button disabled={offset === 0} onClick={() => { setOffset(0) }}>{t('code.first')}</button>
        <button disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset) }}>{t('code.next')}</button></div>
    </>}
  </section>
}
