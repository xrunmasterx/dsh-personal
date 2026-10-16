// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createViewStore } from '../src/client/view-store.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

it('keeps the sidebar selection across every navigation destination', () => {
  const view = createViewStore().create()
  expect(view.getSnapshot().sidebarCollapsed).toBe(false)
  view.actions.toggleSidebar()
  for (const page of ['reflection', 'tapd', 'crash', 'runs', 'profile', 'storage', 'chat', 'board'] as const) {
    view.actions.navigate(page)
    expect(view.getSnapshot()).toMatchObject({ page, sidebarCollapsed: true })
  }
  view.actions.toggleSidebar()
  expect(view.getSnapshot().sidebarCollapsed).toBe(false)
})

it('restores only a valid collapsed preference and tolerates denied storage', () => {
  localStorage.setItem('personal-workbench.sidebar-collapsed', 'true')
  expect(createViewStore().create().getSnapshot().sidebarCollapsed).toBe(true)
  localStorage.setItem('personal-workbench.sidebar-collapsed', 'invalid')
  expect(createViewStore().create().getSnapshot().sidebarCollapsed).toBe(false)
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
  const view = createViewStore().create()
  view.actions.toggleSidebar()
  expect(view.getSnapshot().sidebarCollapsed).toBe(true)
})

it('opens native panels under Sessions and returns to the companion on business pages', () => {
  const view = createViewStore().create()
  const settings = 'settings' as MainPanelId
  view.actions.selectPanel(settings)
  expect(view.getSnapshot()).toMatchObject({ page: 'chat', panelInfo: { activePanelId: settings } })
  view.actions.navigate('board')
  expect(view.getSnapshot()).toMatchObject({ page: 'board', panelInfo: { activePanelId: null } })
  view.actions.selectPanel(settings)
  view.actions.retainMainPanels([])
  expect(view.getSnapshot().panelInfo.activePanelId).toBeNull()
})
it('keeps native rightbar track and fullscreen state separate from the companion', () => {
  const view = createViewStore().create()
  view.actions.openRightbar(false, true)
  expect(view.getSnapshot()).toMatchObject({ page: 'board', detailsOpen: false, rightbarFullscreen: true })
  view.actions.openRightbar(true, false)
  expect(view.getSnapshot()).toMatchObject({ detailsOpen: true, rightbarFullscreen: false })
  view.actions.closeRightbar()
  expect(view.getSnapshot()).toMatchObject({ detailsOpen: false, rightbarFullscreen: false })
})

it('shares companion preferences across pages and clamps resizing', () => {
  localStorage.setItem('personal-workbench.agent-width', '560')
  localStorage.setItem('personal-workbench.agent-open', 'false')
  const view = createViewStore().create()
  expect(view.getSnapshot()).toMatchObject({ agentWidth: 560, agentOpen: false })
  view.actions.navigate('reflection')
  expect(view.getSnapshot()).toMatchObject({ agentWidth: 560, agentOpen: false })
  view.actions.setAgentWidth(900)
  expect(view.getSnapshot().agentWidth).toBe(720)
  view.actions.setAgentWidth(10)
  expect(view.getSnapshot().agentWidth).toBe(320)
  view.actions.setAgentOpen(true)
  expect(view.getSnapshot().agentOpen).toBe(true)
})
it('uses the companion default for malformed persisted widths', () => {
  localStorage.setItem('personal-workbench.agent-width', 'NaN')
  expect(createViewStore().create().getSnapshot().agentWidth).toBe(480)
})
