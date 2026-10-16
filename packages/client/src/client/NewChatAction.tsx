/** Explicit native conversation creation in the existing Agent toolbar. */
import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './NewChatAction.module.css'

/**
 * Render creation progress and failures without changing the previous conversation.
 * @param props - localized copy and the current Personal context's native creation action.
 * @returns Compact toolbar action.
 */
export function NewChatAction({ start, t }: PropsLocale<'personal-workbench'> & { start: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <span className={css.root}>
    <button className={css.button} disabled={busy} aria-label={t('agent.newChat')} title={t('agent.newChatHint')}
      onClick={() => { if (busy) return; setBusy(true); setError(''); void start().catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error))
      }).finally(() => { setBusy(false) }) }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M16 3l5 5M10 14l1-5 8-8 5 5-8 8z" transform="translate(-1 1) scale(.95)" />
      </svg>
    </button>
    {error && <span role="alert">{error}</span>}
  </span>
}
