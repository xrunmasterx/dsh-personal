// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { CodeArchive } from '../src/client/CodeArchive.tsx'
import { zh } from '../src/client/locales.ts'
const t = ((key: keyof typeof zh) => zh[key]) as ComponentProps<typeof CodeArchive>['t']
afterEach(cleanup)
it('reads without triggering analysis and exposes explicit sync and recoverable errors', async () => {
  const list = vi.fn(async () => ({ items: [], total: 0, nextOffset: null, running: false, lastScan: null, error: null }))
  const sync = vi.fn(async () => { throw new Error('Source unavailable') })
  render(<CodeArchive api={{ list, sync, interval: () => 30000 }} t={t} pollIntervalMs={30000} />)
  await screen.findByText(zh['code.empty'])
  expect(sync).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['history.sync'] }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Error: Source unavailable')
  expect(sync).toHaveBeenCalledWith(false)
})
it('scopes task evidence without a second synchronization control', async () => {
  const list = vi.fn(async () => ({ items: [], total: 0, nextOffset: null, running: false, lastScan: null, error: null }))
  render(<CodeArchive api={{ list, sync: vi.fn(), interval: () => 30000 }} taskId="task" t={t} pollIntervalMs={30000} />)
  await waitFor(() => { expect(list).toHaveBeenCalledWith(0, 'task') })
  expect(screen.queryByRole('button', { name: zh['history.sync'] })).toBeNull()
})
