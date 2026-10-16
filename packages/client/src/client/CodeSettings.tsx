/** Native preferences for repository polling and independent analysis. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodeSettings as Preferences } from '@xrunmasterx/dsh-personal-host/client'
import css from './History.module.css'

/**
 * Edit source and model settings using the native persistence owner.
 * @param props Preference scope, registered models and localized copy.
 * @returns Compact settings form.
 */
export function CodeSettings({ scope, load, t }: { scope: SettingsScope<Preferences>
  load: () => Promise<{ provider: string; model: string; label: string }[]>
  t: TranslateNS<'personal-workbench'> }) {
  const state = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [models, setModels] = useState<{ provider: string; model: string; label: string }[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void load().then((value) => { if (active) setModels(value) }, (e: unknown) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [load])
  const value = state.value
  const update = <K extends keyof Preferences>(key: K, next: Preferences[K]) => {
    setBusy(true); setError('')
    void scope.set(key, next).then(() => {
      if (JSON.stringify(scope.getSnapshot().value?.[key]) !== JSON.stringify(next)) setError(t('history.saveFailed'))
    }, (e: unknown) => { setError(String(e)) }).finally(() => { setBusy(false) })
  }
  return <section className={`${css.panel} ${css.settings}`} aria-label={t('code.settings')}>
    <h3>{t('code.settings')}</h3><p className={css.meta}>{t('code.retentionHint')}</p>
    {error && <p role="alert">{error}</p>}
    {value && <>
      <label className={css.setting}>{t('code.enabled')}<input type="checkbox" checked={value.enabled} disabled={busy || !state.writable} onChange={(e) => { update('enabled', e.target.checked) }} /></label>
      {(['repository', 'author', 'branchPrefix', 'validationBranch', 'checkBranchPrefix', 'mainBranch'] as const).map(key =>
        <label className={css.setting} key={key}>{t(`code.${key}`)}<input key={value[key]} defaultValue={value[key]} disabled={busy || !state.writable}
          onBlur={(e) => { if (e.target.value !== value[key]) update(key, e.target.value.trim()) }} /></label>)}
      <label className={css.setting}>{t('history.interval')}<select disabled={busy || !state.writable} value={value.intervalMinutes} onChange={(e) => { update('intervalMinutes', Number(e.target.value)) }}>
        {[...new Set([15, 30, 60, 120, 360, 1440, value.intervalMinutes])].map(n => <option key={n} value={n}>{t('history.minutes', { count: n })}</option>)}</select></label>
      <label className={css.setting}>{t('code.lookback')}<input type="number" min={1} max={31} defaultValue={value.lookbackDays} disabled={busy || !state.writable} onBlur={(e) => { if (Number(e.target.value) !== value.lookbackDays) update('lookbackDays', Number(e.target.value)) }} /></label>
      <label className={css.setting}>{t('code.retention')}<input type="number" min={1} max={12} defaultValue={value.retentionMonths} disabled={busy || !state.writable}
        onBlur={(e) => { if (Number(e.target.value) !== value.retentionMonths) update('retentionMonths', Number(e.target.value)) }} /></label>
      <label className={css.setting}>{t('history.model')}<select disabled={busy || !state.writable} value={JSON.stringify(value.model)} onChange={(e) => { update('model', JSON.parse(e.target.value) as Preferences['model']) }}>
        <option value={JSON.stringify(value.model)}>{models.find(m => m.provider === value.model.provider && m.model === value.model.model)?.label ?? `${value.model.provider} / ${value.model.model}`}</option>
        {models.filter(m => m.provider !== value.model.provider || m.model !== value.model.model).map(m => <option key={`${m.provider}/${m.model}`} value={JSON.stringify({ provider: m.provider, model: m.model })}>{m.label}</option>)}
      </select></label>
    </>}
  </section>
}
