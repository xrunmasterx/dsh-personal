/** Root entry navigation and official panel geometry; business data lives in the Remote owner. */
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Product navigation destinations. */
export type WorkbenchPage = 'board' | 'reflection' | 'tapd' | 'crash' | 'runs' | 'profile' | 'storage' | 'chat' | 'archive' | 'code'

interface ViewState {
  page: WorkbenchPage
  sidebarCollapsed: boolean
  agentOpen: boolean
  agentWidth: number
  detailsOpen: boolean
  rightbarFullscreen: boolean
  panelInfo: PanelInfo
}

type ViewActions = {
  setAgentOpen(draft: ViewState, open: boolean): void
  setAgentWidth(draft: ViewState, width: number): void
  navigate(draft: ViewState, page: WorkbenchPage): void
  toggleSidebar(draft: ViewState): void
  closeRightbar(draft: ViewState): void
  retainMainPanels(draft: ViewState, ids: readonly string[]): void
  selectPanel(draft: ViewState, id: MainPanelId | null): void
  openRightbar(draft: ViewState, track: boolean, fullscreen: boolean): void
}

const SIDEBAR_PREFERENCE = 'personal-workbench.sidebar-collapsed'

function readAgentPreference(): { agentOpen: boolean; agentWidth: number } {
  try {
    const width = Number(localStorage.getItem('personal-workbench.agent-width'))
    return { agentOpen: localStorage.getItem('personal-workbench.agent-open') !== 'false',
      agentWidth: Number.isFinite(width) && width >= 320 && width <= 720 ? width : 480 }
  } catch {
    // Storage may be unavailable; the mounted layout remains adjustable.
    return { agentOpen: true, agentWidth: 480 }
  }
}

function readSidebarPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PREFERENCE) === 'true'
  } catch {
    // Blocked browser storage leaves navigation usable with the expanded default.
    return false
  }
}

/**
 * Create viewing state for one root registration.
 * @returns store handle whose actions are attached to the ILayout service.
 */
export function createViewStore(): EngineStoreHandle<ViewState, ViewActions> {
  return defineStore<ViewState, ViewActions>({
    init: () => ({ page: 'board', sidebarCollapsed: readSidebarPreference(), ...readAgentPreference(),
      detailsOpen: false, rightbarFullscreen: false, panelInfo: { activePanelId: null } }),
    actions: {
      setAgentOpen: (draft, open) => { draft.agentOpen = open },
      setAgentWidth: (draft, width) => { draft.agentWidth = Math.max(320, Math.min(720, width)) },
      retainMainPanels: (draft, ids) => {
        if (draft.panelInfo.activePanelId !== null && !ids.includes(draft.panelInfo.activePanelId)) {
          draft.panelInfo = { activePanelId: null }
        }
      },
      selectPanel: (draft, id) => { draft.panelInfo = { activePanelId: id }; draft.page = 'chat' },
      openRightbar: (draft, track, fullscreen) => { draft.detailsOpen = track; draft.rightbarFullscreen = fullscreen },
      navigate: (draft, page: WorkbenchPage) => {
        draft.page = page
        draft.panelInfo = { activePanelId: null }
      },
      toggleSidebar: (draft) => {
        draft.sidebarCollapsed = !draft.sidebarCollapsed

      },
      closeRightbar: (draft) => {
        draft.detailsOpen = false
        draft.rightbarFullscreen = false
      },
    },
  })
}
