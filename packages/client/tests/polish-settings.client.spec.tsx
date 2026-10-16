// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { PolishSettings, type PolishSettingsProps } from '../src/client/PolishSettings.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const route = { provider: 'tencent-copilot', model: 'deepseek-v4-flash-ioa' }
const t = ((key: keyof typeof zh) => zh[key]) as PolishSettingsProps['t']
function harness(reject = false) {
  const state: SettingsScopeSnapshot<{ model: typeof route }> = { status: 'ready', value: { model: route }, base: {}, user: {}, revision: 0, writable: true, mode: 'host' }
  const set = vi.fn(async (_field: string, value: unknown) => { if (reject) throw new Error('Settings conflict'); state.value = { model: value as typeof route } })
  const scope: SettingsScope<{ model: typeof route }> = {
    getSnapshot: () => state, subscribe: () => () => {}, set, unset: vi.fn(), mutate: vi.fn(),
  }
  const load = vi.fn(async () => [{ ...route, label: 'Tencent Flash' }, { provider: 'another', model: 'fast', label: 'Another model' }])
  render(<PolishSettings scope={scope} load={load} t={t} />)
  return { set }
}

it('saves provider and model together through native settings without a model call', async () => {
  const { set } = harness()
  const select = screen.getByRole('combobox', { name: '润色模型' })
  await waitFor(() => { expect((select as HTMLSelectElement).disabled).toBe(false) })
  fireEvent.change(select, { target: { value: '1' } })
  await waitFor(() => { expect(set).toHaveBeenCalledWith('model', { provider: 'another', model: 'fast' }) })
  expect(set).toHaveBeenCalledTimes(1)
})

it('keeps the saved route and reports a rejected preference write', async () => {
  harness(true)
  const select = screen.getByRole('combobox', { name: '润色模型' }) as HTMLSelectElement
  await waitFor(() => { expect(select.disabled).toBe(false) })
  fireEvent.change(select, { target: { value: '1' } })
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(select.value).toBe('0')
})
