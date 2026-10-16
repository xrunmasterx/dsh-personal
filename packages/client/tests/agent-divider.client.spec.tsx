// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentDivider } from '../src/client/AgentDivider.tsx'

afterEach(cleanup)
it('resizes in the direction of the divider keys without owning width state', () => {
  const change = vi.fn()
  const view = render(<AgentDivider width={480} onChange={change} label="Agent width" />)
  const divider = screen.getByRole('separator')
  fireEvent.keyDown(divider, { key: 'ArrowLeft' })
  expect(change).toHaveBeenLastCalledWith(500)
  view.rerender(<AgentDivider width={500} onChange={change} label="Agent width" />)
  fireEvent.keyDown(divider, { key: 'ArrowRight' })
  expect(change).toHaveBeenLastCalledWith(480)
  expect({ role: divider.getAttribute('role'), orientation: divider.getAttribute('aria-orientation'),
    width: divider.getAttribute('aria-valuenow'), min: divider.getAttribute('aria-valuemin'), max: divider.getAttribute('aria-valuemax') }).toMatchInlineSnapshot(`
    {
      "max": "720",
      "min": "320",
      "orientation": "vertical",
      "role": "separator",
      "width": "500",
    }
  `)
})
