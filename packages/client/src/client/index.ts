import { PersonalMark } from './PersonalMark.tsx'
import { CodeSettings } from './CodeSettings.tsx'
import type { CodeSettings as CodePreferences } from '@xrunmasterx/dsh-personal-host/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { JournalId, TaskSessionId } from '@xrunmasterx/dsh-personal-host/client'
/** Personal L-layout assembly retaining the official shell's four child slots. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ThemeSnapshot, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@xrunmasterx/dsh-personal-api/client'
import { NewChatAction } from './NewChatAction.tsx'
import { Workbench, type WorkbenchInjected } from './Workbench.tsx'
import { WorkbenchClient } from './data.ts'
import { archiveTaskSession, openBoardSession, openTaskSession } from './task-sessions.ts'
import { en, NS, zh, type WorkbenchKey } from './locales.ts'
import { createViewStore } from './view-store.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { PolishSettings, type PolishSettingsProps } from './PolishSettings.tsx'

import { HistorySettings } from './HistorySettings.tsx'
import type { HistorySettings as HistoryPreferences } from '@xrunmasterx/dsh-personal-host/client'

const PERSONAL_THEME_TOKENS = {
  '--dsw-alias-bg-base': { light: '#f5f5f2', dark: '#1c1c1b' },
  '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#292927' },
  '--dsw-alias-bg-layer-2': { light: '#eeefec', dark: '#262625' },
  '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#363633' },
  '--dsw-alias-bg-module-platform': { light: '#f1f1ee', dark: '#242423' },
  '--dsw-alias-border-l1': { light: '#e1e1dc', dark: '#363633' },
  '--dsw-alias-border-l2': { light: '#ddded8', dark: '#393938' },
  '--dsw-alias-border-l3': { light: '#c9cbc3', dark: '#484847' },
  '--dsw-alias-border-l4': { light: '#b5b7ae', dark: '#5a5a57' },
  '--dsw-alias-brand-primary': { light: '#343432', dark: '#e5e5df' },
  '--dsw-alias-state-business-primary': { light: '#343432', dark: '#e5e5df' },
  '--dsw-alias-state-error-primary': { light: '#ae4f45', dark: '#e18a7e' },
  '--dsw-alias-state-success-primary': { light: '#53715a', dark: '#8dad92' },
  '--dsw-alias-state-warn-primary': { light: '#96672f', dark: '#d0a46b' },
  '--dsw-alias-label-primary': { light: '#272724', dark: '#eeeeea' },
  '--dsw-alias-label-secondary': { light: '#55564f', dark: '#c7c7bf' },
  '--dsw-alias-label-tertiary': { light: '#72746b', dark: '#a3a39a' },
  '--dsw-alias-label-caption': { light: '#7d7f75', dark: '#93938a' },
  '--dsw-alias-interactive-bg-active': { light: '#e9e9e4', dark: '#393936' },
  '--dsw-alias-interactive-bg-hover': { light: 'rgb(39 39 36 / 5%)', dark: 'rgb(238 238 234 / 6%)' },
  '--dsw-alias-interactive-bg-hover-solid': { light: '#eeefec', dark: '#343433' },
  '--dsw-alias-button-primary-fill': { light: '#343432', dark: '#e5e5df' },
  '--dsw-alias-button-primary-hover': { light: '#4a4a46', dark: '#f5f5f0' },
  '--dsw-specific-sidebar-fill': { light: '#eeefec', dark: '#262625' },
  '--dsw-alias-bg-layer-3': { light: '#ffffff', dark: '#363633' },
  '--dsw-alias-bg-multi-select': { light: '#eeefec', dark: '#363633' },
  '--dsw-alias-button-elevated-fill': { light: '#ffffff', dark: '#343433' },
  '--dsw-alias-button-floating-fill': { light: '#ffffff', dark: '#363633' },
  '--dsw-alias-button-floating-hover': { light: '#eeefec', dark: '#393938' },
  '--dsw-alias-button-ghost-active-border': { light: '#c9cbc3', dark: '#5a5a57' },
  '--dsw-alias-button-ghost-active-fill': { light: '#eeefec', dark: '#343433' },
  '--dsw-alias-button-ghost-active-hover': { light: '#e4e5df', dark: '#393938' },
  '--dsw-alias-button-info-fill': { light: '#343432', dark: '#c7c7bf' },
  '--dsw-alias-button-info-hover': { light: '#4a4a46', dark: '#343432' },
  '--dsw-alias-button-primary-dimmed': { light: '#e4e5df', dark: '#393938' },
  '--dsw-alias-label-primary-dimmed': { light: '#55564f', dark: '#c7c7bf' },
  '--dsw-alias-label-primary-foreground': { light: '#ffffff', dark: '#1c1c1b' },
  '--dsw-alias-label-primary-inverted': { light: '#ffffff', dark: '#1c1c1b' },
  '--dsw-alias-markdown-code-block-banner': { light: '#eeefec', dark: '#262625' },
  '--dsw-alias-markdown-code-block': { light: '#f1f1ee', dark: '#242423' },
  '--dsw-alias-markdown-inline-code': { light: '#eeefec', dark: '#343433' },
  '--dsw-alias-state-business-tertiary': { light: '#e9e9e4', dark: '#393936' },
  '--dsw-alias-scrollbar-bg-l1': { light: '#c9cbc3', dark: '#484847' },
  '--dsw-alias-scrollbar-bg-l2': { light: '#c9cbc3', dark: '#484847' },
  '--dsw-alias-scrollbar-hover-l1': { light: '#b5b7ae', dark: '#5a5a57' },
  '--dsw-alias-scrollbar-hover-l2': { light: '#b5b7ae', dark: '#5a5a57' },
  '--dsw-specific-input-major': { light: '#ffffff', dark: '#2b2b29' },
  '--dsw-specific-bubble': { light: '#eeefec', dark: '#2b2b29' },
  '--dsw-specific-bubble-highlight': { light: '#e9e9e4', dark: '#393936' },
  '--dsw-specific-selector': { light: '#eeefec', dark: '#363633' },
} satisfies ThemeTokenOverrides

export type { WorkbenchInjected, WorkbenchProps } from './Workbench.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'personal-workbench': WorkbenchKey
  }
}

/** Wait for the explicit feature Remote as well as the official shell services. */
export const inject = ['slots', 'locale', 'theme', 'remote', 'remote.personalWorkbench', 'sessions', 'workspaces']

function presentTheme(ctx: Context): () => void {
  const body = document.body
  const initialScheme = document.documentElement.style.colorScheme
  const initialDark = body.getAttribute('data-ds-dark-theme')
  const initialVariables = new Map<string, string>()
  let applied: string[] = []
  const apply = (snapshot: ThemeSnapshot) => {
    for (const name of applied) body.style.removeProperty(name)
    const values = { ...snapshot.active.tokens, '--dsh-content-font-size': `${snapshot.fontSize}px` }
    applied = Object.keys(values)
    for (const [name, value] of Object.entries(values)) {
      if (!initialVariables.has(name)) initialVariables.set(name, body.style.getPropertyValue(name))
      body.style.setProperty(name, value)
    }
    document.documentElement.style.colorScheme = snapshot.active.colorScheme
    if (snapshot.active.colorScheme === 'dark') body.setAttribute('data-ds-dark-theme', '')
    else body.removeAttribute('data-ds-dark-theme')
  }
  apply(ctx.theme.getTheme())
  const off = ctx.on('theme/change', apply)
  return () => {
    off()
    document.documentElement.style.colorScheme = initialScheme
    if (initialDark === null) body.removeAttribute('data-ds-dark-theme')
    else body.setAttribute('data-ds-dark-theme', initialDark)
    for (const [name, value] of initialVariables) {
      if (value) body.style.setProperty(name, value)
      else body.style.removeProperty(name)
    }
  }
}

/**
 * Provide ILayout and the single root owner; no official conversation slot is replaced.
 * @param ctx - browser plugin Context.
 * @returns disposer stopping only the browser's local polling.
 */
export function apply(ctx: Context): () => void {
  const client = new WorkbenchClient(ctx.remote.personalWorkbench)
  let startNewChat: (() => Promise<void>) | undefined
  const taskDrafts = new Map<JournalId, TaskSessionId>()
  const handle = createViewStore()
  const instance = handle.create()
  const store: typeof handle = { ...handle, create: () => instance }
  let navigation = new AbortController()
  const layout: ILayout = {
    selectPanel: (id) => {
      if (id !== null && !ctx.slots.entries('main').some(entry => entry.options.key === id)) throw new Error(`Personal panel is unavailable: ${id}`)
      navigation.abort()
      instance.actions.selectPanel(id)
    },
    beginNavigation: () => { navigation.abort(); navigation = new AbortController(); return navigation.signal },
    toggleSidebar: () => { instance.actions.toggleSidebar() },
    openRightbar: (track, fullscreen) => { instance.actions.openRightbar(track, fullscreen) },
    closeRightbar: () => { instance.actions.closeRightbar() },
  }
  ctx.effect(() => () => { navigation.abort() }, 'Personal navigation lifetime')
  ctx.effect(() => ctx.slots.provideRoot({ hooks: { panelInfo: {
    getSnapshot: () => instance.getSnapshot().panelInfo,
    subscribe: listener => instance.subscribe(listener),
  } } }), 'Personal main panel selection')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'Personal workbench dictionaries')
  ctx.inject(['settingsScope'], (settingsCtx) => {
    const scope = settingsCtx.settingsScope.bind<{ model: { provider: string; model: string } }>({ namespace: 'personal-workbench-polish' })
    const load: PolishSettingsProps['load'] = async () => {
      const models = await ctx.remote.personalWorkbench.polishModels()
      if (!models.ok) throw new Error(models.error.message)
      return models.value
    }
    const codeScope = settingsCtx.settingsScope.bind<CodePreferences>({ namespace: 'personal-workbench-code' })
    settingsCtx.slots.inject('settings.models.footer', () => settingsCtx.slots.register({
      name: 'settings.models.footer', id: 'personal-workbench-code', order: 52,
      inject: () => ({ scope: codeScope, load, t: settingsCtx.locale.bind(NS) }),
    }, CodeSettings))
    const historyScope = settingsCtx.settingsScope.bind<HistoryPreferences>({ namespace: 'personal-workbench-history' })
    settingsCtx.slots.inject('settings.models.footer', () => settingsCtx.slots.register({
      name: 'settings.models.footer', id: 'personal-workbench-history', order: 51,
      inject: () => ({ scope: historyScope, load, t: settingsCtx.locale.bind(NS) }),
    }, HistorySettings))
    settingsCtx.slots.inject('settings.models.footer', () => settingsCtx.slots.register({
      name: 'settings.models.footer', id: 'personal-workbench-polish', order: 50,
      inject: () => ({ scope, load, t: settingsCtx.locale.bind(NS) }),
    }, PolishSettings))
  })
  ctx.effect(() => ctx.reflect.provide('layout', layout), 'Personal layout service')
  ctx.effect(
    () => ctx.theme.overrideTokens('personal-workbench', PERSONAL_THEME_TOKENS),
    'Personal workbench warm neutral palette',
  )
  ctx.effect(() => presentTheme(ctx), 'Personal theme presentation')
  const callbacks: WorkbenchInjected = {
    reviews: {
      read: day => client.reviewRead(day), sync: day => client.reviewSync(day),
      edit: request => client.reviewEdit(request), source: id => client.reviewSource(id),
    },
    journalUploadImage: (data, mediaType) => client.journalUploadImage(data, mediaType),
    journalReadImage: destination => client.journalReadImage(destination),
    journalQuery: query => client.journalQuery(query),
    journalWrite: request => client.journalWrite(request),
    journalHistory: (id, offset) => client.journalHistory(id, offset),
    journalActivity: (from, to, offset) => client.journalActivity(from, to, offset),
    journalWeek: (day, offset) => client.journalWeek(day, offset),
    journalReport: day => client.journalReport(day),
    journalSaveReport: request => client.journalSaveReport(request),
    journalEvent: id => client.journalEvent(id),
    polishBrief: async (text, mode, status) => {
      try {
        const sessionId = ctx.sessions.list.getSnapshot().current ?? await ctx.sessions.create()
        return await client.journalPolish({ sessionId, text, mode: mode ?? 'polish', status: status ?? 'todo' })
      } catch (error) {
        ctx.logger.warn('Task description polishing failed', error)
        throw error
      }
    },
    assist: async (text) => {
      const id = ctx.sessions.list.getSnapshot().current ?? await ctx.sessions.create()
      ctx.sessions.open(id)
      const scope = ctx.sessions.scope(id)
      if (!scope) throw new Error('The selected DSH session is unavailable')
      const conversation = scope.get('conversation')
      if (!conversation) throw new Error('The selected DSH conversation is unavailable')
      await conversation.send(text)
    },
    beginBoardSession: async (week, signal) => {
      const info = client.data.getSnapshot().info
      if (!info) throw new Error('Personal workbench configuration is not loaded')
      const open = (fresh: boolean) => openBoardSession(ctx.sessions, ctx.workspaces, info.sourceRoot, ctx.locale.bind(NS)('nav.board'),
        async (id) => {
          const nativeId = id as string as Parameters<typeof ctx.sessions.open>[0]
          const result = await ctx.remote.personalWorkbench.prepareBoardSession(nativeId, week)
          if (!result.ok) throw new Error(result.error.message)
        }, signal, fresh)
      startNewChat = () => open(true)
      await open(false)
    },
    beginTaskSession: async (taskId, title, signal, fresh = false) => {
      const previous = ctx.sessions.list.getSnapshot().current
      const saved = taskDrafts.get(taskId)
      const blank = saved && ctx.sessions.list.getSnapshot().byId[saved as string as Parameters<typeof ctx.sessions.open>[0]]?.blank
      const id = (fresh && !blank ? undefined : saved) ?? randomUUID() as TaskSessionId
      startNewChat = async () => { await callbacks.beginTaskSession(taskId, title, signal, true) }
      const info = client.data.getSnapshot().info
      if (!info) throw new Error('Personal workbench configuration is not loaded')
      const nativeId = id as string as Parameters<typeof ctx.sessions.open>[0]
      await openTaskSession(ctx.sessions, ctx.workspaces,
        { id, title, state: 'pending', provider: 'dsh', createdAt: new Date().toISOString() },
        async () => {
          const result = await ctx.remote.personalWorkbench.prepareTaskSession(nativeId, taskId)
          if (!result.ok) throw new Error(result.error.message)
        }, info.sourceRoot, signal)
      taskDrafts.set(taskId, id)
      return () => {
        if (ctx.sessions.list.getSnapshot().current !== nativeId) return
        if (previous) ctx.sessions.open(previous)
        else ctx.sessions.clear()
      }
    },
    openTaskSession: (session, taskId) => {
      const info = client.data.getSnapshot().info
      if (!info) throw new Error('Personal workbench configuration is not loaded')
      return openTaskSession(ctx.sessions, ctx.workspaces, session, async () => {
        const nativeId = session.id as string as Parameters<typeof ctx.sessions.open>[0]
        const result = await ctx.remote.personalWorkbench.prepareTaskSession(nativeId, taskId)
        if (!result.ok) throw new Error(result.error.message)
      }, info.sourceRoot)
    },
    archiveTaskSession: session => archiveTaskSession(ctx.sessions, ctx.workspaces, session),
    code: {
      interval: () => {
        const info = client.data.getSnapshot().info
        if (!info) throw new Error('Workbench configuration is not loaded')
        return info.idlePollIntervalMs
      },
      list: async (offset, taskId) => {
        const result = await ctx.remote.personalWorkbench.codeList(null, null, offset, taskId)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      sync: async (retry) => {
        const result = await ctx.remote.personalWorkbench.codeSync(retry)
        if (!result.ok) throw new Error(result.error.message)
      },
    },
    history: {
      list: async (taskId, mode, offset, text, source) => {
        const r = await ctx.remote.personalWorkbench.historyList(taskId, mode, offset, text, source)
        if (!r.ok) throw new Error(r.error.message)
        return r.value
      },
      read: async (id, offset) => {
        const r = await ctx.remote.personalWorkbench.historyRead(id, offset)
        if (!r.ok) throw new Error(r.error.message)
        return r.value
      },
      sync: async (retry) => {
        const r = await ctx.remote.personalWorkbench.historySync(retry)
        if (!r.ok) throw new Error(r.error.message)
      },
      rule: async (request) => {
        const r = await ctx.remote.personalWorkbench.historyRule(request)
        if (!r.ok) throw new Error(r.error.message)
      },
      tasks: query => client.journalQuery(query),
    },
    hooks: { workbench: client.data, taskSessions: ctx.sessions.list, taskWorkspaces: ctx.workspaces.list },
    refresh: () => client.refresh(),
    refreshTapd: () => client.refreshTapd(),
    loadLinkedCrashes: query => client.loadLinkedCrashes(query),
    search: query => client.search(query),
    reports: (query, issueId) => client.reports(query, issueId),
    prepare: request => client.prepare(request),
    clearPlan: () => {
      client.clearPlan()
    },
    start: id => client.start(id),
    cancel: id => client.cancel(id),
    readReport: id => client.readReport(id),
    refreshEvidence: () => client.refreshEvidence(),
    generate: id => client.generate(id),
    cancelProfile: id => client.cancelProfile(id),
    review: request => client.review(request),
    publish: request => client.publish(request),
    activate: (page) => {
      client.activate(page)
    },
    loadRuns: query => client.loadRuns(query),
    readRun: id => client.readRun(id),
    inspectIssue: (query, id) => client.inspectIssue(query, id),
    closeIssue: () => {
      client.closeIssue()
    },
    closeReports: () => {
      client.closeReports()
    },
    readEvidence: (id, evidenceId, offset) => client.readEvidence(id, evidenceId, offset),
    loadProfile: (id, draftOffset, versionOffset) => client.loadProfile(id, draftOffset, versionOffset),
    readVersion: id => client.readVersion(id),
    previewCleanup: history => client.previewCleanup(history),
    cleanStorage: (token, history) => client.cleanStorage(token, history),
  }
  ctx.effect(
    () =>
      ctx.slots.register(
        {
          name: 'root',
          locale: NS,
          children: {
            sidebar: { kind: 'single', scope: 'root' },
            main: { kind: 'keyed', scope: 'root' },
            rightbar: { kind: 'single', scope: 'root' },
            'shell.overlay': { kind: 'list', scope: 'root' },
          },
          store,
          inject: () => callbacks,
        },
        Workbench,
      ),
    'Personal root and official shell slots',
  )
  ctx.effect(() => {
    const retain = () => {
      instance.actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const off = ctx.slots.subscribe('main', retain)
    retain()
    return off
  }, 'Personal available main panels')
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark', priority: -1,
  }, PersonalMark))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'personal-new-chat', locale: NS, order: 30,
    inject: () => ({ start: async () => { if (startNewChat) await startNewChat() } }),
  }, NewChatAction))
  void client.initialize()
  return () => {
    client.close()
  }
}
