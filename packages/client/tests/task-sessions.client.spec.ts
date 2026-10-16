// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TaskSession, TaskSessionId } from '@xrunmasterx/dsh-personal-host/client'
import { archiveTaskSession, openBoardSession, openTaskSession } from '../src/client/task-sessions.ts'

const link: TaskSession = {
  id: '00000000-0000-4000-8000-000000000007' as TaskSessionId,
  provider: 'dsh',
  title: 'Reflection investigation',
  state: 'pending',
  createdAt: '2026-09-08T00:00:00Z',
}
function native(existing?: { blank: boolean; cwd?: string }, draft = '', attached = true) {
  const workspaces = {
    list: { getSnapshot: () => ({ items: attached ? [{ workspaceId: 'ws', sessionIds: [link.id] }] : [] }) },
    archiveSession: vi.fn(async () => {}),
    create: vi.fn(async () => ({ workspaceId: 'ws' })),
  }
  const input = { state: { getSnapshot: () => ({ draft }) }, setDraft: vi.fn() }
  const face = { rename: vi.fn(async () => ({ ok: true })) }
  const scope = { get: () => ({ input: { for: () => input } }) }
  const sessions = {
    refresh: vi.fn(async () => {}),
    list: { getSnapshot: () => ({ byId: existing ? { [link.id]: existing } : {} }) },
    create: vi.fn(async () => link.id),
    open: vi.fn(),
    clear: vi.fn(),
    scope: () => scope,
    sessionOf: () => face,
  }
  return {
    sessions,
    input,
    face,
    workspaces,
    workspaceService: workspaces as unknown as IWorkspaces,
    service: sessions as unknown as ISessions,
  }
}
describe('task conversations use native DSH ownership', () => {
  it('prepares context before selection and never selects after cancellation or preparation failure', async () => {
    const h = native()
    const controller = new AbortController()
    const prepare = vi.fn(async () => {
      expect(h.sessions.open).not.toHaveBeenCalled()
      controller.abort()
    })
    await expect(openTaskSession(h.service, h.workspaceService, link, prepare, '/project', controller.signal)).rejects.toThrow()
    expect(prepare).toHaveBeenCalledOnce()
    expect(h.sessions.open).not.toHaveBeenCalled()
    await expect(openTaskSession(h.service, h.workspaceService, link, async () => { throw new Error('Offline') }, '/project')).rejects.toThrow('Offline')
    expect(h.sessions.open).not.toHaveBeenCalled()
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })

  it('repairs an ungrouped blank session using its existing directory and identity', async () => {
    const h = native({ blank: true, cwd: '/original' }, '', false)
    await openTaskSession(
      h.service,
      h.workspaceService,
      { ...link, state: 'ready' },
      async () => {},
      '/project',
    )
    expect(h.workspaces.create).toHaveBeenCalledWith({ path: '/original' })
    expect(h.sessions.create).toHaveBeenCalledWith({ sessionId: link.id, workspaceId: 'ws' })
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })

  it('creates the reserved identity, selects it without exposing context in the composer', async () => {
    const h = native()
    await openTaskSession(h.service, h.workspaceService, link, async () => {}, '/project')
    expect(h.sessions.create).toHaveBeenCalledExactlyOnceWith({ sessionId: link.id, workspaceId: 'ws' })
    expect(h.sessions.open).toHaveBeenCalledWith(link.id)
    expect(h.face.rename).toHaveBeenCalledWith(link.title)
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })
  it('resumes cold ready history with the same identity without renaming or replacing its composer', async () => {
    const h = native({ blank: false }, 'Unsent work')
    await openTaskSession(
      h.service,
      h.workspaceService,
      { ...link, state: 'ready' },
      async () => {},
      '/project',
    )
    expect(h.sessions.open).toHaveBeenCalledWith(link.id)
    expect(h.sessions.create).toHaveBeenCalledWith({ sessionId: link.id, workspaceId: 'ws' })
    expect(h.face.rename).not.toHaveBeenCalled()
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })
  it('never replaces a deleted ready session with empty history', async () => {
    const h = native()
    await expect(
      openTaskSession(h.service, h.workspaceService, { ...link, state: 'ready' }, async () => {}, '/project'),
    ).rejects.toThrow('unavailable')
    expect(h.sessions.create).not.toHaveBeenCalled()
    expect(h.sessions.open).not.toHaveBeenCalled()
  })
  it('adopts an interrupted reservation and preserves an existing draft', async () => {
    const h = native({ blank: true }, 'My additions')
    await openTaskSession(h.service, h.workspaceService, link, async () => {}, '/project')
    expect(h.sessions.create).toHaveBeenCalledWith({ sessionId: link.id, workspaceId: 'ws' })
    expect(h.sessions.open).toHaveBeenCalledWith(link.id)
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })
})

describe('native task conversation archival', () => {
  it('clears the archived selection only after successful persistence', async () => {
    const h = native({ blank: false })
    h.sessions.list.getSnapshot = () => ({ byId: {}, current: link.id })
    await archiveTaskSession(h.service, h.workspaceService, link)
    expect(h.workspaces.archiveSession).toHaveBeenCalledExactlyOnceWith(link.id)
    expect(h.sessions.clear).toHaveBeenCalledExactlyOnceWith()
    expect(h.sessions.create).not.toHaveBeenCalled()
  })
  it('preserves the selection on rejection and when another conversation is selected', async () => {
    const h = native({ blank: false })
    h.workspaces.archiveSession.mockRejectedValueOnce(new Error('Offline'))
    await expect(archiveTaskSession(h.service, h.workspaceService, link)).rejects.toThrow('Offline')
    expect(h.sessions.clear).not.toHaveBeenCalled()
    await archiveTaskSession(h.service, h.workspaceService, link)
    expect(h.sessions.clear).not.toHaveBeenCalled()
  })
})

describe('board conversation restoration', () => {
  it('reopens persisted native history after a new client mount without renaming or clearing it', async () => {
    localStorage.clear()
    localStorage.setItem('personal-workbench.board-session:/personal', link.id)
    const h = native({ blank: false }, 'draft')
    const prepare = vi.fn(async () => {})
    await openBoardSession(h.service, h.workspaceService, '/personal', 'Board', prepare)
    expect(prepare).toHaveBeenCalledWith(link.id)
    expect(h.sessions.open).toHaveBeenCalledWith(link.id)
    expect(h.face.rename).not.toHaveBeenCalled()
    expect(h.input.setDraft).not.toHaveBeenCalled()
  })
  it('persists a first conversation only after successful preparation and isolates directories', async () => {
    localStorage.clear()
    const h = native()
    await openBoardSession(h.service, h.workspaceService, '/personal', 'Board', async () => {})
    const id = localStorage.getItem('personal-workbench.board-session:/personal')
    expect(id).toBeTruthy()
    expect(h.sessions.open).toHaveBeenCalledWith(id)
    await expect(openBoardSession(h.service, h.workspaceService, '/other', 'Board', async () => { throw new Error('Offline') })).rejects.toThrow('Offline')
    expect(localStorage.getItem('personal-workbench.board-session:/other')).toBeNull()
  })
  it('does not replace deleted saved history with an empty conversation', async () => {
    localStorage.clear()
    localStorage.setItem('personal-workbench.board-session:/personal', link.id)
    const h = native()
    await expect(openBoardSession(h.service, h.workspaceService, '/personal', 'Board', async () => {})).rejects.toThrow('unavailable')
    expect(h.sessions.create).not.toHaveBeenCalled()
    expect(localStorage.getItem('personal-workbench.board-session:/personal')).toBe(link.id)
  })
})

it('explicit new board chat preserves the old session and replaces the saved selection', async () => {
  localStorage.clear()
  localStorage.setItem('personal-workbench.board-session:/personal', link.id)
  const h = native({ blank: false }, 'old draft')
  await openBoardSession(h.service, h.workspaceService, '/personal', 'Board', async () => {}, undefined, true)
  expect(localStorage.getItem('personal-workbench.board-session:/personal')).not.toBe(link.id)
  expect(h.input.setDraft).not.toHaveBeenCalled()
  expect(h.workspaces.archiveSession).not.toHaveBeenCalled()
})
it('explicit new board chat reuses an already blank conversation', async () => {
  localStorage.clear()
  localStorage.setItem('personal-workbench.board-session:/personal', link.id)
  const h = native({ blank: true })
  await openBoardSession(h.service, h.workspaceService, '/personal', 'Board', async () => {}, undefined, true)
  expect(localStorage.getItem('personal-workbench.board-session:/personal')).toBe(link.id)
  expect(h.sessions.open).toHaveBeenCalledWith(link.id)
})
