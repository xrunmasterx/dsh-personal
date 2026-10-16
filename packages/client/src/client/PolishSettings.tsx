/** Native Models settings contribution for the independent task editor route. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PolishSettings.module.css'

interface Route { provider: string; model: string }
/** Native settings and model-directory callbacks injected by the owning plugin. */
export interface PolishSettingsProps {
  scope: SettingsScope<{ model: Route }>
  load: () => Promise<Array<Route & { label: string }>>
  t: TranslateNS<'personal-workbench'>
}

/**
 * Select a persisted LLM route without altering conversation model settings.
 * @param props - native settings scope, registered model loader and locale.
 * @returns compact model preference row.
 */
export function PolishSettings({ scope, load, t }: PolishSettingsProps) {
  const state = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [options, setOptions] = useState<Array<Route & { label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    void load().then((value) => { if (active) setOptions(value) }, () => { if (active) setError(true) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load, attempt])
  const current = state.value?.model
  const index = options.findIndex(option => option.provider === current?.provider && option.model === current.model)
  const select = async (value: string) => {
    const route = options[Number(value)]
    if (!route || saving) return
    setSaving(true)
    setError(false)
    try {
      await scope.set('model', { provider: route.provider, model: route.model })
      const saved = scope.getSnapshot().value?.model
      if (saved?.provider !== route.provider || saved.model !== route.model) setError(true)
    } catch { setError(true) }
    finally { setSaving(false) }
  }
  return <section className={css.row} aria-label={t('polishSettings.title')}>
    <div><h3>{t('polishSettings.title')}</h3><p>{t('polishSettings.hint')}</p></div>
    <select aria-label={t('polishSettings.model')} value={String(index)} disabled={loading || saving || !state.writable}
      onChange={(event) => { void select(event.target.value) }}>
      {index < 0 && <option value="-1" disabled>{loading ? t('polishSettings.loading') : current ? `${current.provider} / ${current.model}` : t('polishSettings.unavailable')}</option>}
      {options.map((option, position) => <option key={`${option.provider}/${option.model}`} value={String(position)}>{option.label}</option>)}
    </select>
    {error && <div role="alert">{t('polishSettings.failed')} <button onClick={() => { setAttempt(value => value + 1) }}>{t('polishSettings.retry')}</button></div>}
  </section>
}
