import { CodeArchive } from './CodeArchive.tsx'
/** Task document and associated native conversations, rendered inside the work area. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { TaskDocument } from './TaskDocument.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  JournalId,
  JournalRow,
  JournalEvent,
  JournalWrite,
  TaskSession,
} from '@xrunmasterx/dsh-personal-host/client'
import type { JournalActions } from './journal-api.ts'
import { useTaskDraft } from './task-draft.ts'
import { localDay } from './journal-calendar.ts'
import common from './Journal.module.css'
import { History } from './History.tsx'
import css from './TaskDetails.module.css'
import historyCss from './History.module.css'

/**
 * Display a free-form task brief above durable DSH session links.
 * @param props - canonical task, native session metadata and revision-checked actions.
 * @returns an in-pane task page that leaves the adjacent composer interactive.
 */
export function TaskDetails({
  row,
  toolbar,
  created,
  api,
  t,
  run,
  changed,
  close,
  busy,
  error,
  sessions,
  archivedSessionIds,
  refresh,
  needsSync,
}: {
  toolbar?: ReactNode
  row: JournalRow | null
  created: (id: JournalId) => void
  api: JournalActions
  t: TranslateNS<'personal-workbench'>
  run: (fn: () => Promise<void>) => Promise<void>
  changed: (receipt?: JournalEvent) => void
  close: () => void
  busy: boolean
  error: string
  archivedSessionIds: WorkspaceSnapshot['archivedSessionIds']
  sessions: SessionListState
  refresh: () => Promise<void>
  needsSync: boolean
}) {
  const [source, setSource] = useState<'all' | 'dsh' | 'codex' | 'cursor'>('all')
  const [externalCount, setExternalCount] = useState(0)
  const [newId] = useState(() => randomUUID() as JournalId)
  const item = row?.item
  const title = item?.title ?? ''
  const description = item ? item.description ?? t('task.template', { title, next: item.nextAction }) : ''
  const { editor: storedEditor, update: setEditor, storageFailed } = useTaskDraft(item?.id ?? 'new')
  const editor = storedEditor ?? (row ? null : { title: '', baseTitle: '', text: '', base: '' })
  const [preview, setPreview] = useState(false)
  // Retain aliases for removed images until the editor unmounts so native undo can restore them.
  const imageAliases = useRef(new Map<string, string>())
  const compactImages = (text: string) => text.replace(
    /(!\[[^\]\n]*\]\()(personal-image:v1:[A-Za-z0-9_-]+)(\))/g,
    (_whole, start: string, destination: string, end: string) => {
      let alias = imageAliases.current.get(destination)
      if (!alias) {
        let index = imageAliases.current.size + 1
        do { alias = `task-image-${index++}` } while (text.includes(alias) || [...imageAliases.current.values()].includes(alias))
        imageAliases.current.set(destination, alias)
      }
      return start + alias + end
    })
  const expandImages = (text: string) => {
    const originals = new Map([...imageAliases.current].map(([destination, alias]) => [alias, destination]))
    return text.replace(/(!\[[^\]\n]*\]\()(task-image-\d+)(\))/g,
      (whole, start: string, alias: string, end: string) => {
        const destination = originals.get(alias)
        return destination === undefined ? whole : start + destination + end
      })
  }
  const draftText = compactImages(editor?.text ?? '')
  const textarea = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const input = textarea.current
    if (!input || preview) return
    const fit = () => {
      input.style.height = 'auto'
      input.style.height = `${input.scrollHeight + 2}px`
    }
    fit()
    let width = input.clientWidth
    const observer = new ResizeObserver(() => {
      if (width !== input.clientWidth) { width = input.clientWidth; fit() }
    })
    observer.observe(input)
    return () => { observer.disconnect() }
  }, [draftText, preview, editor !== null])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const uploadPending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const insertImages = (files: File[]) => {
    if (!editor || busy || uploadPending.current || files.length === 0) return
    uploadPending.current = true
    const position = textarea.current?.selectionStart ?? draftText.length
    const selectionEnd = textarea.current?.selectionEnd ?? position
    void run(async () => {
      setUploading(true)
      setUploadError('')
      try {
        const destinations: string[] = []
        for (const file of files) {
          const encoded = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => { reject(new Error(t('task.imageFailed'))) }
            reader.onload = () => {
              if (typeof reader.result === 'string') resolve(reader.result.split(',')[1] ?? '')
              else reject(new Error(t('task.imageFailed')))
            }
            reader.readAsDataURL(file)
          })
          destinations.push(await api.journalUploadImage(encoded, file.type))
        }
        const insertion = '\n\n' + destinations.map(url => `![${t('task.screenshot')}](${url})`).join('\n\n') + '\n\n'
        const text = expandImages(draftText.slice(0, position) + compactImages(insertion) + draftText.slice(selectionEnd))
        if (text.length > 20_000) throw new Error(t('task.imageTooLong'))
        if (mounted.current) setEditor({ ...editor, text })
      } catch (error) {
        if (mounted.current) setUploadError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }).finally(() => {
      uploadPending.current = false
      if (mounted.current) setUploading(false)
    })
  }
  const briefElement = useRef<HTMLDetailsElement>(null)
  const startEditing = () => {
    if (briefElement.current) briefElement.current.open = true
    setPreview(false)
    setEditor({ title, baseTitle: title, text: description, base: description })
  }
  const [autoPolish, setAutoPolish] = useState(true)
  const [polishing, setPolishing] = useState(false)
  const [original, setOriginal] = useState<{ text: string; polished: string } | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [contextError, setContextError] = useState('')
  const taskId = item?.id
  const taskTitle = useRef(title)
  const beginTaskSession = api.beginTaskSession
  useEffect(() => {
    if (!taskId) return
    const controller = new AbortController()
    let release: (() => void) | undefined
    setContextError('')
    void beginTaskSession(taskId, taskTitle.current, controller.signal).then((dispose) => {
      if (controller.signal.aborted) dispose()
      else release = dispose
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setContextError(error instanceof Error ? error.message : String(error))
    })
    return () => { controller.abort(); release?.() }
  }, [taskId, beginTaskSession])

  const dirty = editor !== null && (editor.text !== editor.base || (editor.title ?? title) !== (editor.baseTitle ?? title))
  const conflict = editor !== null && (editor.base !== description || (editor.baseTitle !== undefined && editor.baseTitle !== title))
  const validInput = Boolean((editor?.title ?? title).trim() || (!row && editor?.text.trim()))
  const save = () =>
    void run(async () => {
      if (uploading || !editor || !dirty || conflict || !validInput) return
      let text = editor.text
      let summary: string | undefined
      let nextTitle = (editor.title ?? title).trim()
      const needsTitle = !nextTitle && !row
      const needsPolish = Boolean(autoPolish && text.trim() && text !== editor.base)
      if (needsTitle || needsPolish) {
        setPolishing(true)
        try {
          const result = await api.polishBrief(text, needsTitle ? needsPolish ? 'both' : 'title' : 'polish', item?.status ?? 'todo')
          if (needsTitle) {
            if (!result.title?.trim()) throw new Error('Task editor returned no title')
            nextTitle = result.title.trim()
          }
          if (needsPolish) {
            summary = result.summary
            text = ([['task.content', result.what], ['task.why', result.why], ['task.progress', result.progress]] as const)
              .filter(([, body]) => body.trim()).map(([heading, body]) => `## ${t(heading)}\n\n${body}`).join('\n\n')
          }
        } catch (error) {
          throw new Error(t('task.polishFailed'), { cause: error })
        } finally {
          setPolishing(false)
        }
      }
      const receipt = await write(row?.revision ?? 0, {
        title: nextTitle, description: text,
        ...(summary === undefined ? {} : { summary }),
      })
      setOriginal(text !== editor.text ? { text: editor.text, polished: text } : null)
      changed(receipt)
      setEditor(null)
      if (!row) created(receipt.itemId)
    })
  const [archiving, setArchiving] = useState<string | null>(null)
  const archived = new Set<string>(archivedSessionIds)
  const links = (item?.sessions ?? []).filter(link => !archived.has(link.id))
  const archive = (link: TaskSession) => void run(async () => {
    setArchiving(link.id)
    try {
      await api.archiveTaskSession(link)
    } finally {
      setArchiving(null)
    }
  })
  const write = (expectedRevision: number, patch: Partial<JournalWrite>) =>
    api.journalWrite({
      requestId: randomUUID() as JournalId,
      itemId: item?.id ?? newId,
      expectedRevision,
      operation: row ? 'update' : 'create',
      day: localDay(),
      reason: t(row ? 'task.editReason' : 'task.createReason'),
      ...patch,
    })
  const open = (link?: TaskSession) =>
    void run(async () => {
      if (!row) return
      setOpening(link?.id ?? 'new')
      try {
        if (!link) {
          await api.beginTaskSession(row.item.id, row.item.title, new AbortController().signal, true)
        } else {
          await api.openTaskSession(link, row.item.id)
        }
      } finally {
        setOpening(null)
      }
    })
  return (
    <section
      className={`${common.journal} ${css.taskPage}`}
      aria-label={t('task.details')}
      data-task-detail="true"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && editor) {
          event.preventDefault()
          save()
        }
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          close()
        }
      }}
    >
      <header className={css.header}>
        <button className={css.back} onClick={close} disabled={busy || uploading} aria-label={t('task.back')}>
          ‹
        </button>
        <div>
          <span className={css.eyebrow}>{t(row ? 'task.details' : 'task.new')}</span>
          {editor ? (
            <input className={css.titleInput} aria-label={t('task.title')} placeholder={t('task.titlePlaceholder')}
              autoFocus maxLength={1000} value={editor.title ?? title} disabled={busy || uploading}
              onChange={(event) => { setEditor({ ...editor, title: event.target.value, baseTitle: editor.baseTitle ?? title }) }} />
          ) : (
            <h1 aria-label={title}><button className={css.titleButton} disabled={busy || uploading} title={t('task.editTitle')}
              aria-label={t('task.editTitle')} onClick={startEditing}>{title}</button></h1>
          )}
        </div>
        {item && <span className={css.status}>{t(`journal.${item.status}`)}</span>}
        {toolbar}
      </header>
      {contextError && <p role="alert" className={common.error}>{contextError}</p>}
      {(uploadError || error) && (
        <p role="alert" className={common.error}>
          {uploadError || error}
        </p>
      )}
      {needsSync && <button onClick={() => void refresh()}>{t('journal.refresh')}</button>}
      <details ref={briefElement} className={css.brief} open aria-label={t('task.brief')}>
        <summary className={css.sectionHead}>
          <h2>{t('task.brief')}</h2>
          <div className={css.briefControls}>
            <label className={css.polishOption} title={t('task.autoPolishHint')}>
              <input type="checkbox" checked={autoPolish} disabled={busy || uploading}
                onChange={(event) => { setAutoPolish(event.target.checked) }} />
              {t('task.autoPolish')}
            </label>
            {!editor && (
              <button
                disabled={busy && !needsSync}
                onClick={startEditing}
              >
                {t('task.edit')}
              </button>
            )}
          </div>
        </summary>
        {editor ? (
          <div className={css.editor}>
            <div className={css.editorModes}>
              <div role="group" aria-label={t('task.editorMode')}>
                <button aria-pressed={!preview} disabled={busy || uploading} onClick={() => { setPreview(false) }}>{t('task.edit')}</button>
                <button aria-pressed={preview} disabled={busy || uploading} onClick={() => { setPreview(true) }}>{t('task.preview')}</button>
              </div>
              <small role="status">{t(uploading ? 'task.imageUploading' : 'task.imageHint')}</small>
            </div>
            {preview ? <div className={css.document}>
              <TaskDocument text={editor.text} readImage={api.journalReadImage} failedLabel={t('task.imageFailed')} retryLabel={t('task.imageRetry')}
                labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }} />
            </div> :
              <textarea
                ref={textarea}
                onCopy={(event) => {
                  const input = event.currentTarget
                  const selected = input.value.slice(input.selectionStart, input.selectionEnd)
                  event.clipboardData.setData('text/plain', expandImages(selected))
                  event.preventDefault()
                }}
                onPaste={(event) => {
                  const images = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
                    .map(item => item.getAsFile()).filter((file): file is File => file !== null)
                  if (images.length) { event.preventDefault(); insertImages(images) }
                }}
                maxLength={20_000}
                aria-label={t('task.brief')}
                placeholder={t('task.briefPlaceholder')}
                value={draftText}
                disabled={busy || uploading}
                onChange={(event) => {
                  setEditor({ ...editor, text: expandImages(event.target.value) })
                }}
              />
            }
            {conflict && <p className={css.conflict}>{t('task.draftConflict')}</p>}
            <div className={css.editActions}>
              <small role="status">
                {storageFailed
                  ? t('task.storageFailed')
                  : dirty
                    ? t(editor.text.includes('personal-image:') ? 'task.imageDraftSaved' : 'task.draftSaved')
                    : t('task.saveShortcut')}
              </small>
              <button disabled={busy || uploading || conflict || !dirty || !validInput} onClick={save}>
                {t(polishing ? 'task.polishing' : busy && !opening && !archiving ? 'task.saving' : row ? 'journal.save' : 'task.create')}
              </button>
              <button
                disabled={busy || uploading}
                onClick={() => {
                  setEditor(null)
                  if (!row) close()
                }}
              >
                {t(dirty ? 'task.discard' : 'journal.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className={css.document}>
            <TaskDocument
              readImage={api.journalReadImage} failedLabel={t('task.imageFailed')} retryLabel={t('task.imageRetry')}
              text={description.replace(/^## (?:What · 要做什么|What)$/gm, `## ${t('task.content')}`)
                .replace(/^## (?:Why · 为什么做|Why)$/gm, `## ${t('task.why')}`)
                .replace(/^## (?:How · 如何推进|How)$/gm, `## ${t('task.progress')}`) || t('task.emptyBrief')}
              labels={{ code: { copyLabel: t('copy'), copiedLabel: t('copied') }, footnotes: t('footnotes') }}
            />
          </div>
        )}
        {!editor && original?.polished === description && (
          <div className={css.polishReceipt}>
            <small role="status">{t('task.polished')}</small>
            <button disabled={busy || uploading} onClick={() => {
              setAutoPolish(false)
              setEditor({ title, baseTitle: title, text: original.text, base: description })
              setOriginal(null)
            }}>{t('task.restoreOriginal')}</button>
          </div>
        )}
        {item && item.links.length > 0 && (
          <div className={css.sources}>
            {item.links.map(source => (
              <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                {source.title} ↗
              </a>
            ))}
          </div>
        )}
      </details>
      {row && api.code && <CodeArchive key={row.item.id} api={api.code} taskId={row.item.id} t={t} pollIntervalMs={api.code.interval()} />}
      <section className={css.sessions} aria-label={t('task.sessions')}>
        <div className={css.sectionHead}>
          <h2>
            {t('task.sessions')} <small>{(source === 'all' || source === 'dsh' ? links.length : 0) + (source === 'dsh' ? 0 : externalCount)}</small>
          </h2>
          <button
            className={css.add}
            disabled={busy || dirty || !row}
            aria-label={t('task.newSession')}
            title={dirty || !row ? t('task.saveBeforeSession') : t('task.newSession')}
            onClick={() => {
              open()
            }}
          >
            {opening === 'new' ? '…' : '＋'}
          </button>
        </div>
        <div className={`${historyCss.toolbar} ${css.sessionFilters}`} aria-label={t('history.source')}>
          {(['all', 'dsh', 'codex', 'cursor'] as const).map(value => <button key={value} aria-pressed={source === value}
            onClick={() => { if (source !== value) { setSource(value); setExternalCount(0) } }}>{t(value === 'dsh' ? 'task.dsh' : `history.${value}`)}</button>)}
        </div>
        <div className={css.sessionScroll} tabIndex={0} aria-label={t('task.sessions')}>
          {row && !links.length && (source === 'dsh' || (source === 'all' && !externalCount)) && <p className={css.empty}>{t('task.noSessions')}</p>}
          {!row && <p className={css.empty}>{t('task.createBeforeSession')}</p>}
          <div className={`${css.sessionList} ${historyCss.panel}`} hidden={source !== 'all' && source !== 'dsh'}>
            {links.map((link) => {
              const native = sessions.byId[link.id as string as keyof SessionListState['byId']]
              const current = String(sessions.current ?? '') === String(link.id)
              return (
                <div key={link.id} className={`${historyCss.card} ${css.sessionRow}`} data-current={current}>
                  <button
                    className={css.session}
                    disabled={busy || uploading}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                      open(link)
                    }}
                  >
                    <span className={css.sessionCopy}>
                      <h3>{native?.title || link.title}</h3>
                      <small>
                        {t('task.dsh')} · {new Date(link.createdAt).toLocaleString()}
                      </small>
                      {link.summary && <p>{link.summary}</p>}
                    </span>
                  </button>
                  <div className={historyCss.toolbar}>
                    <button disabled={busy || uploading} onClick={() => { open(link) }}>
                      {t(
                        opening === link.id
                          ? 'task.opening'
                          : link.state === 'pending'
                            ? 'task.pending'
                            : native?.running
                              ? 'task.running'
                              : current
                                ? 'task.current'
                                : 'task.continue',
                      )}
                    </button>
                    <button
                      className={css.archive}
                      disabled={busy || native?.running}
                      aria-label={t('task.archiveSession', { title: native?.title || link.title })}
                      title={t(native?.running ? 'task.archiveRunning' : 'task.archiveHint')}
                      onClick={() => { archive(link) }}
                    >
                      {archiving === link.id ? '…' : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                          <path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {row && api.history && <div hidden={source === 'dsh'}><History key={`${row.item.id}:${source}`} api={api.history} t={t}
            taskId={row.item.id} taskSource={source === 'dsh' ? 'all' : source} onCount={setExternalCount} /></div>}
        </div>
      </section>
    </section>
  )
}
