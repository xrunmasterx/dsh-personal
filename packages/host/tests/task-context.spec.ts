import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TaskContext } from '../src/task-context.ts'
import { WorkJournal, type JournalId } from '../src/journal.ts'
import { harness } from './helpers.ts'

const taskId = '00000000-0000-4000-8000-000000000001' as JournalId
const sessionId = SessionId('00000000-0000-4000-8000-000000000002')

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 8, 18, 12)) })
afterEach(() => { vi.useRealTimers() })

describe('task-scoped native conversation context', () => {
  it('prepares without a journal link, links once on user send and reads the latest saved brief', async () => {
    const h = await harness()
    await h.ctx.plugin(SessionStore)
    await h.ctx.plugin(SystemPrompt)
    const journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
    try {
      await journal.write({ requestId: taskId, itemId: taskId, expectedRevision: 0, operation: 'create', day: '2026-09-16', title: 'IBL alignment', description: 'Preserve diffuse conditions', reason: 'User created task' })
      const service = new TaskContext(h.ctx, journal)
      const session = h.ctx.sessions.create(sessionId)
      // This extension only reads the session and uses the agent as a scope identity.
      const agent = { session } as Agent
      await service.prepare(sessionId, taskId)
      await service.prepare(sessionId, taskId)
      expect(h.ctx.personalRecords.binding(String(sessionId))).toEqual({ taskId })
      expect(session.snapshotEvents()).toHaveLength(0)
      expect(journal.readItem(taskId).item.sessions).toBeUndefined()
      const assemble = () => h.ctx.systemPrompt.assemble(assembleContextFor(agent))
      expect((await assemble()).sections).toMatchSnapshot()
      const user = createUserMessage({ content: [{ type: 'text', text: 'What should I check?' }], source: { kind: 'user' } })
      const fire = (messages = [user]) => agentEvents(h.ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages }))
      await fire([])
      expect(journal.readItem(taskId).revision).toBe(1)
      await fire()
      await fire()
      expect(journal.readItem(taskId).revision).toBe(3)
      expect(journal.readItem(taskId).item.sessions).toMatchObject([{ id: sessionId, state: 'ready' }])
      await journal.write({ requestId: '00000000-0000-4000-8000-000000000003' as JournalId, itemId: taskId, expectedRevision: 3, operation: 'update', day: '2026-09-16', description: 'New specular limitation', reason: 'User edited brief' })
      expect((await assemble()).sections.find(section => section.name === 'personal-workbench-task')?.text).toContain('New specular limitation')
      const other = h.ctx.sessions.create(SessionId('unrelated'))
      expect((await h.ctx.systemPrompt.assemble(assembleContextFor({ session: other } as Agent))).sections.find(section => section.name === 'personal-workbench-task')?.text).toBe('')
      expect(session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
      await expect(service.prepare(SessionId('missing'), taskId)).rejects.toThrow('unavailable')
      other.append('user/message', user, { surfaceOp: 'append' })
      await expect(service.prepare(other.id, taskId)).rejects.toThrow('unrelated')
    } finally { await journal.close(); await h.close() }
  })
})

it('records multi-task board progress atomically, isolates task sessions and preserves undo', async () => {
  const h = await harness()
  await h.ctx.plugin(SessionStore)
  await h.ctx.plugin(SystemPrompt)
  const journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
  try {
    const service = new TaskContext(h.ctx, journal)
    const session = h.ctx.sessions.create(sessionId)
    await service.prepareBoard(sessionId, '2026-09-14')
    await service.prepareBoard(sessionId, '2026-09-14')
    expect(h.ctx.personalRecords.binding(String(sessionId))).toEqual({ week: '2026-09-14' })
    const request = { requestId: taskId, itemId: taskId, expectedRevision: 0, operation: 'create' as const,
      day: '2026-09-17', title: 'IBL alignment', description: 'Validated mobile diffuse', text: 'Yesterday I tested mobile diffuse', reason: 'User report' }
    const first = await service.write(session, request, 'Mobile diffuse validated')
    expect(await service.write(session, request, 'Mobile diffuse validated')).toEqual(first)
    expect(first.after).toMatchObject({ status: 'todo', sessions: [{ id: sessionId, state: 'ready', summary: 'Mobile diffuse validated' }] })
    expect(first.log?.text).toBe(request.text)
    const other = '00000000-0000-4000-8000-000000000003' as JournalId
    await service.write(session, { ...request, requestId: other, itemId: other, title: 'New work', status: 'active' }, 'Started new work')
    expect(journal.readItem(other).item.sessions?.[0]?.id).toBe(sessionId)
    await service.prepare(sessionId, taskId)
    const prompt = await h.ctx.systemPrompt.assemble(assembleContextFor({ session } as Agent))
    expect(prompt.sections.find(section => section.name === 'personal-workbench-task')?.text).toMatchSnapshot()
    await service.prepareBoard(sessionId, '2026-09-21')
    expect((await h.ctx.systemPrompt.assemble(assembleContextFor({ session } as Agent))).sections.find(section => section.name === 'personal-workbench-task')?.text).toContain('2026-09-21')
    const updateId = '00000000-0000-4000-8000-000000000004' as JournalId
    const changed = await service.write(session, { ...request, requestId: updateId, operation: 'update', expectedRevision: 1, description: 'Validated diffuse; specular pending' }, 'Diffuse verified; specular remains')
    expect(changed.log?.text).toBe(request.text)
    expect(changed.after?.sessions).toHaveLength(1)
    await expect(service.write(session, { ...request, requestId: other, operation: 'update', expectedRevision: 1 }, 'stale')).rejects.toThrow()
    await service.write(session, { requestId: '00000000-0000-4000-8000-000000000005' as JournalId, itemId: taskId,
      expectedRevision: 2, operation: 'undo', day: '2026-09-18', reason: 'Undo report' }, '')
    expect(journal.readItem(taskId).item.sessions?.[0]?.summary).toBe('Mobile diffuse validated')
    expect(journal.readItem(taskId).item.description).toBe('Validated mobile diffuse')
    const dedicated = h.ctx.sessions.create(SessionId('00000000-0000-4000-8000-000000000006'))
    await service.prepare(dedicated.id, taskId)
    await expect(service.prepareBoard(dedicated.id, '2026-09-14')).rejects.toThrow('task conversation')
    await expect(service.write(dedicated, { ...request, itemId: other }, 'wrong task')).rejects.toThrow('another task')
  } finally { await journal.close(); await h.close() }
})
