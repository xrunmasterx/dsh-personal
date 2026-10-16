import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { describe, expect, it, vi } from 'vitest'
import { WorkJournal } from '../src/journal.ts'
import { registerJournalTools } from '../src/journal-tools.ts'
import { harness } from './helpers.ts'

// Exercise the real tool definitions and durable journal; transport is covered by the assembled snapshot.
async function setup() {
  const h = await harness()
  const journal = await WorkJournal.open(h.ctx, 2, 1_048_576)
  const definitions = new Map<string, ToolDefinition>()
  const disposers: (() => void)[] = []
  const ask = vi.fn(async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({
    answers: request.questions.map(q => ({ id: q.id, selected: ['暂不调整'] })),
  }))
  const ctx = {
    personalWorkbench: {
      journalWrite: journal.write.bind(journal),
      journalHistory: journal.history.bind(journal),
    },
    userQuestions: { ask },
    tools: { register: (tool: ToolDefinition) => {
      definitions.set(tool.name, tool)
      return () => { definitions.delete(tool.name) }
    } },
    effect: (effect: () => () => void) => { disposers.push(effect()) },
  } as unknown as Context
  registerJournalTools(ctx)
  const tool = definitions.get('journal_write')!
  const controller = new AbortController()
  const exec = { signal: controller.signal } as ToolRunContext
  const change = JSON.stringify({ operation: 'create', expectedRevision: 0,
    day: '2026-09-07', title: 'A suggested plan', reason: 'Suggestion' })
  return { journal, definitions, ask, controller,
    call: (intent: string) => tool.execute({ intent, change }, exec),
    async close() {
      for (const dispose of disposers) dispose()
      await journal.close()
      await h.close()
    },
  }
}

describe('native journal write confirmation', () => {
  it('declines suggestions without writing; accepted suggestions and explicit instructions persist', async () => {
    const h = await setup()
    try {
      await h.call('suggestion')
      expect(h.journal.query({ from: null, to: null, text: '', offset: 0, includeOpen: true }).total).toBe(0)
      h.ask.mockImplementation(async request => ({ answers: request.questions.map(q => ({ id: q.id, selected: ['采纳'] })) }))
      await h.call('suggestion')
      await h.call('explicit')
      expect(h.ask).toHaveBeenCalledTimes(2)
      expect(h.journal.query({ from: null, to: null, text: '', offset: 0, includeOpen: true }).total).toBe(2)
    } finally { await h.close() }
    expect(h.definitions.size).toBe(0)
  })

  it('does not commit when the session is canceled while waiting for confirmation', async () => {
    const h = await setup()
    try {
      h.ask.mockImplementation(async (request) => {
        h.controller.abort()
        return { answers: request.questions.map(q => ({ id: q.id, selected: ['采纳'] })) }
      })
      await expect(h.call('suggestion')).rejects.toThrow()
      expect(h.journal.query({ from: null, to: null, text: '', offset: 0, includeOpen: true }).total).toBe(0)
    } finally { await h.close() }
  })
})
