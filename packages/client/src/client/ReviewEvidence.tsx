/** Named, dated source groups; full text loads only when the reader opens a message. */
import { useEffect, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewSource, ReviewWeek } from '@xrunmasterx/dsh-personal-host/client'
import type { ReviewActions } from './Retrospective.tsx'
import css from './Retrospective.module.css'

type Copy = TranslateNS<'personal-workbench'>
type Source = ReviewWeek['sources'][number]
function role(source: Source, t: Copy) {
  return t(source.role.startsWith('assistant') ? 'review.assistant' : source.role.startsWith('user') ? 'review.user' : 'review.record')
}
function SourceBody({ source, t }: { source: ReviewSource; t: Copy }) {
  const markdown = (text: string) => <MarkdownText text={text} labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />
  if (source.kind !== 'code' && source.role !== 'recorded-user-change') return markdown(source.text)
  let record: unknown
  try { record = JSON.parse(source.text) }
  catch (error) {
    // Older retained evidence may be plain text rather than a structured receipt.
    if (error instanceof SyntaxError) return markdown(source.text)
    throw error
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return markdown(source.text)
  const fields = record as Record<string, unknown>
  const stage = fields.stage
  const status = (value: unknown) => value === 'todo' || value === 'active' || value === 'blocked' || value === 'done' || value === 'canceled' ? t(`journal.${value}`) : ''
  const change = fields.statusChange && typeof fields.statusChange === 'object' ? fields.statusChange as Record<string, unknown> : null
  return <>
    {typeof fields.reason === 'string' && <p><strong>{t('review.context')}</strong> {fields.reason}</p>}
    {stage === 'development' || stage === 'validation' || stage === 'main' ? <p>{t(`code.${stage}`)} · {t('review.observed')}</p> : null}
    {change && <p>{t('journal.status')}: {status(change.from)} → {status(change.to)}</p>}
    {['progress', 'message', 'analysis'].map(key => typeof fields[key] === 'string' && <div key={key}>{markdown(fields[key])}</div>)}
    <details><summary>{t('review.rawRecord')}</summary><pre className={css.sourceText}>{JSON.stringify(record, null, 2)}</pre></details>
  </>
}
function Evidence({ source, api, t, zone, initialOpen = false }: {
  source: Source
  api: ReviewActions
  t: Copy
  zone: string
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  const [full, setFull] = useState<ReviewSource | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || full) return
    let active = true
    setError('')
    void api.source(source.id).then((value) => { if (active) setFull(value) }, (e: unknown) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [api, source.id, open, retry, full])
  const time = Number.isNaN(Date.parse(source.at)) ? source.day : new Date(source.at).toLocaleTimeString(undefined, { timeZone: zone, hour: '2-digit', minute: '2-digit' })
  return <details className={css.evidence} open={open} onToggle={(e) => { setOpen(e.currentTarget.open) }}>
    <summary>{role(source, t)} · {time}</summary>
    {open && <>
      {error && <p role="alert">{error} <button onClick={() => { setRetry(n => n + 1) }}>{t('review.retry')}</button></p>}
      {full ? <>
        {full.url && <p><a href={full.url} target="_blank" rel="noreferrer">{t('review.openSource')}</a></p>}
        <SourceBody source={full} t={t} />
      </> : !error && <small>{t('review.loading')}</small>}
    </>}
  </details>
}

/** Group cited sources by conversation, kind and occurrence date without fetching their bodies.
 * @param props Sources cited by this card and the existing source reader.
 * @returns Expandable conversation groups with individually readable messages.
 */
export function ReviewEvidence({ sources, api, t, zone }: { sources: Source[]; api: ReviewActions; t: Copy; zone: string }) {
  const groups = new Map<string, [Source, ...Source[]]>()
  for (const source of sources) {
    const key = JSON.stringify([source.kind, source.label, source.day])
    const group = groups.get(key)
    if (group) group.push(source)
    else groups.set(key, [source])
  }
  return <section aria-label={t('review.source')} className={css.sources}>
    {[...groups.entries()].map(([key, group]) => {
      const heading = <><strong>{group[0].label}</strong><small>{t(`review.${group[0].kind}`)} · {group[0].day} · {t('review.sourceCount', { count: group.length })}</small></>
      const messages = group.toSorted((a, b) => a.at.localeCompare(b.at)).map(source =>
        <Evidence key={source.id} source={source} api={api} t={t} zone={zone} initialOpen={sources.length === 1} />)
      return groups.size === 1
        ? <div key={key} className={css.sourceGroup}><div className={css.sourceHeading}>{heading}</div>{messages}</div>
        : <details key={key} className={css.sourceGroup}><summary>{heading}</summary>{messages}</details>
    })}
  </section>
}
