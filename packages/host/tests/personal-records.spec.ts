import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JournalId } from '../src/journal.ts'
import { harness } from './helpers.ts'

describe('external Personal persistence', () => {
  it('restores bindings without adding unknown required events to native chat', async () => {
    const h = await harness()
    const root = h.root
    try {
      const id = SessionId('external-personal-chat')
      const session = Session.create(id)
      const taskId = '00000000-0000-4000-8000-000000000001' as JournalId
      await h.ctx.personalRecords.bind(String(id), { taskId })
      await h.ctx.personalRecords.audit(String(id), 'personal-workbench/brief-polish-request', { input: 'original wording' })
      expect(session.snapshotEvents()).toEqual([])
      await h.close(false)
      const reopened = await harness(root)
      try { expect(reopened.ctx.personalRecords.binding(String(id))).toEqual({ taskId }) }
      finally { await reopened.close(true) }
    } catch (error) { await h.close(); throw error }
  })
})
