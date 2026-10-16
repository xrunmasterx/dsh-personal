// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { NewChatAction } from '../src/client/NewChatAction.tsx'
import { zh } from '../src/client/locales.ts'
const t = ((key: keyof typeof zh) => zh[key]) as ComponentProps<typeof NewChatAction>['t']
afterEach(cleanup)
it('shows a retryable creation error and prevents duplicate clicks while pending', async () => {
  const pending = Promise.withResolvers<void>()
  const start = vi.fn(() => pending.promise)
  render(<NewChatAction start={start} t={t} />)
  const button = screen.getByRole('button', { name: zh['agent.newChat'] })
  expect(button.title).toMatchInlineSnapshot(`"新建聊天；旧对话保留，正在运行的任务会继续"`)
  fireEvent.click(button)
  fireEvent.click(button)
  expect(start).toHaveBeenCalledTimes(1)
  pending.reject(new Error('Offline'))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline')
  await waitFor(() => { expect(button).toHaveProperty('disabled', false) })
})
