/** Independent native settings for automatic conversation analysis. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { HistorySettings as Preferences } from '@xrunmasterx/dsh-personal-host/client'
import css from './History.module.css'

/**
 * Persist archive preferences without changing any live conversation model.
 * @param props - native preference scope, model directory and locale.
 * @returns settings rows in the existing Personal visual style.
 */
export function HistorySettings({ scope, load, t }: {
  scope: SettingsScope<Preferences>
  load: () => Promise<{ provider: string; model: string; label: string }[]>
  t: TranslateNS<'personal-workbench'>
}) {
  const state = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [models, setModels] = useState<{ provider: string; model: string; label: string }[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let active = true
    void load().then((result) => { if (active) setModels(result) }, (error: unknown) => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [load])
  const value = state.value
  const update = <K extends keyof Preferences>(key: K, next: Preferences[K]) => {
    setBusy(true); setSaved(false); setError('')
    void scope.set(key, next).then(() => {
      if (JSON.stringify(scope.getSnapshot().value?.[key]) !== JSON.stringify(next)) setError(t('history.saveFailed'))
      else setSaved(true)
    }, (error: unknown) =>{  setError(String(error)) }).finally(() =>{  setBusy(false) })
  }
  const current = models.findIndex(m => m.provider === value?.model.provider && m.model === value.model.model)
  return <section className={`${css.panel} ${css.settings}`} aria-label={t('history.settings')}>
    <div className={css.toolbar}><h3>{t('history.settings')}</h3>
      <span role="status" className={css.meta}>{busy ? t('history.saving') : saved ? t('history.saved') : ''}</span>
    </div>
    <p className={css.meta}>{t('history.backgroundHint')}</p>
    {error && <p role="alert" className={css.error}>{error}</p>}
    {value ? <>
      {(['enabled', 'codex', 'cursor'] as const).map(key => <label className={css.setting} key={key}>{t(`history.${key}`)}
        <input type="checkbox" checked={value[key]} disabled={busy || !state.writable} onChange={(event) =>{  update(key, event.target.checked) }} /></label>)}
      <label className={css.setting}>{t('history.model')}<select value={String(current)} disabled={busy || !state.writable} onChange={(event) => {
        const selected = models[Number(event.target.value)]; if (selected) update('model', { provider: selected.provider, model: selected.model })
      }}><option value="-1" disabled>{`${value.model.provider} / ${value.model.model}`}</option>
        {models.map((model, i) => <option key={`${model.provider}/${model.model}`} value={String(i)}>{model.label}</option>)}</select></label>
      <label className={css.setting}>{t('history.interval')}<select value={String(value.intervalMinutes)} disabled={busy || !state.writable} onChange={(event) =>{  update('intervalMinutes', Number(event.target.value)) }}>
        {[...new Set([5, 15, 30, 60, 120, 360, 720, 1440, value.intervalMinutes])].sort((a, b) => a - b)
          .map(minutes => <option key={minutes} value={String(minutes)}>{t(minutes % 60 === 0 ? 'history.hours' : 'history.minutes', { count: minutes % 60 === 0 ? minutes / 60 : minutes })}</option>)}
      </select></label>
      <label className={css.setting}>{t('history.lookback')}<select value={value.lookback} disabled={busy || !state.writable} onChange={(event) =>{  update('lookback', event.target.value as Preferences['lookback']) }}>
        {(['week', '7', '14', 'month'] as const).map(window => <option key={window} value={window}>{t(`history.${window}`)}</option>)}
      </select></label>
    </> : <p>{t('history.loading')}</p>}
  </section>
}
