/** Bind task-owned session references to the official DSH session and composer services. */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { TaskSessionId } from '@xrunmasterx/dsh-personal-host/client'
import type { TaskSession } from '@xrunmasterx/dsh-personal-host/client'

/**
 * Resume a reservation or select existing history without sending a model message.
 * @param sessions - official session controller.
 * @param workspaces - official workspace registration and membership.
 * @param link - durable task association; only pending reservations may create a session.
 * @param prepare - persist hidden context before selecting the conversation.
 * @param sourceRoot - Personal profile directory for new task conversations.
 * @param signal - cancellation when the task view closes or changes.
 * @returns completion after the native session is selected and addressable.
 */
export async function openTaskSession(
  sessions: ISessions,
  workspaces: IWorkspaces,
  link: TaskSession,
  prepare: () => Promise<void>,
  sourceRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const id = link.id as string as Parameters<ISessions['open']>[0]
  signal?.throwIfAborted()
  await sessions.refresh()
  signal?.throwIfAborted()
  const existing = sessions.list.getSnapshot().byId[id]
  if (!existing && link.state === 'ready')
    throw new Error('The linked DSH session is unavailable; it may have been deleted')
  const owner = workspaces.list.getSnapshot().items.find(workspace => workspace.sessionIds.includes(id))
  if (!existing) {
    const workspace = await workspaces.create({ path: sourceRoot })
    await sessions.create({ sessionId: id, workspaceId: workspace.workspaceId })
  }
  signal?.throwIfAborted()
  await prepare()
  signal?.throwIfAborted()
  if (existing?.blank && !owner) {
    const workspace = await workspaces.create({ path: existing.cwd ?? sourceRoot })
    await sessions.create({ sessionId: id, workspaceId: workspace.workspaceId })
    signal?.throwIfAborted()
  }
  if (existing && !existing.blank) { sessions.open(id); return }
  const scope = sessions.scope(id)
  if (!scope) throw new Error('The task session is not addressable')
  const face = sessions.sessionOf(scope)
  if (!face) throw new Error('The task session has no session service')
  if (!existing) {
    const renamed = await face.rename(link.title)
    if (!renamed.ok) throw new Error(renamed.error.message)
  }
  signal?.throwIfAborted()
  sessions.open(id)
}

/**
 * Archive through native workspace state; clear selection only after success.
 * @param sessions - official selection owner, retaining history and drafts.
 * @param workspaces - authoritative native archive command.
 * @param link - task association whose native conversation is archived.
 * @returns completion after archive persistence and any current selection cleanup.
 */
export async function archiveTaskSession(
  sessions: ISessions,
  workspaces: IWorkspaces,
  link: TaskSession,
): Promise<void> {
  const id = link.id as string as Parameters<ISessions['open']>[0]
  await workspaces.archiveSession(id)
  if (sessions.list.getSnapshot().current === id) sessions.clear()
}

/**
 * Restore the board conversation for this browser origin and Personal directory.
 * @param sessions - native session owner, also responsible for durable history.
 * @param workspaces - native workspace membership.
 * @param sourceRoot - Personal directory used to isolate the saved selection.
 * @param title - localized title for a first conversation.
 * @param prepare - persist the selected week before showing the session.
 * @param signal - cancellation when navigation changes.
 * @param fresh - explicitly start a new conversation unless the saved one is blank.
 * @returns completion after selection and browser preference persistence; missing history is never recreated.
 */
export async function openBoardSession(
  sessions: ISessions,
  workspaces: IWorkspaces,
  sourceRoot: string,
  title: string,
  prepare: (id: TaskSessionId) => Promise<void>,
  signal?: AbortSignal,
  fresh = false,
): Promise<void> {
  const key = `personal-workbench.board-session:${sourceRoot}`
  let saved = localStorage.getItem(key)
  if (fresh && saved) {
    await sessions.refresh()
    signal?.throwIfAborted()
    const nativeId = saved as Parameters<ISessions['open']>[0]
    if (!sessions.list.getSnapshot().byId[nativeId]?.blank) saved = null
  }
  const id = (saved ?? randomUUID()) as TaskSessionId
  await openTaskSession(sessions, workspaces,
    { id, title, provider: 'dsh', state: saved ? 'ready' : 'pending', createdAt: new Date().toISOString() },
    () => prepare(id), sourceRoot, signal)
  localStorage.setItem(key, id)
}
