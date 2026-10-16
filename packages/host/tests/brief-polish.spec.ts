import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { polishBrief } from '../src/brief-polish.ts'
import { config, harness as storageHarness } from './helpers.ts'

const policy = config('/unused').briefPolish
const sessionId = SessionId('native-session-not-a-uuid')
const result = { summary: '尚未验证；计划运行测试。', what: '检查 IBL。', why: '', progress: '尚未验证；计划运行 2 次测试。' }
const contexts: Context[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); contexts.splice(0) })

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  constructor(private chunks: StreamChunk[], private dispatch: () => void) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    this.dispatch()
    yield* this.chunks
  }
}

async function harness(text = JSON.stringify(result), finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }) {
  const h = await storageHarness()
  cleanups.push(() => h.close())
  const ctx = h.ctx
  vi.spyOn(ctx.personalRecords, 'audit')
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const session = ctx.sessions.create(sessionId)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Unrelated private conversation' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const adapter = new Adapter([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text }, finish,
  ], () => {
    expect(vi.mocked(ctx.personalRecords.audit).mock.calls.at(-1)?.[1]).toBe('personal-workbench/brief-polish-request')
  })
  ctx.llm.registerAdapter(['fixture'], adapter)
  return { ctx, session, adapter }
}

describe('DSH task description polishing', () => {
  it('logs the exact tool-free request and result without exposing chat history or changing its surface', async () => {
    const { ctx, session, adapter } = await harness()
    const text = '检查 IBL，还没验证，计划测 2 次。'
    expect(await polishBrief(ctx, policy, { sessionId, text }, new AbortController().signal)).toEqual(result)
    const call = adapter.calls[0]!
    expect(call.tools).toBeUndefined()
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0]?.content).toEqual([{ type: 'text', text: JSON.stringify({ draft: text, mode: 'polish', status: 'todo' }) }])
    expect(call.system).toMatchSnapshot()
    expect(call).toMatchObject({ provider: 'fixture', model: 'fixture', reasoningEffort: 'off', maxTokens: 12000, sessionId })
    const events = vi.mocked(ctx.personalRecords.audit).mock.calls
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['user/message'])
    expect(events.map(event => event[1])).toEqual(['personal-workbench/brief-polish-request', 'personal-workbench/brief-polish-result'])
    expect(events[0]?.[2]).toMatchObject({ system: call.system, messages: call.messages })
    expect(events[1]?.[2]).toMatchObject({ requestId: expect.any(String), result })
  })

  it('uses the provider default when a selected model has no reasoning control', async () => {
    const { ctx, session, adapter } = await harness()
    vi.spyOn(adapter, 'resolveModel').mockResolvedValue({ provider: 'fixture', id: 'fixture', name: 'Fixture' })
    expect(await polishBrief(ctx, policy, { sessionId, text: 'draft' }, new AbortController().signal)).toEqual(result)
    expect(adapter.calls[0]?.reasoningEffort).toBeUndefined()
    expect(vi.mocked(ctx.personalRecords.audit).mock.calls[0]?.[2]).toMatchObject({ reasoningEffort: 'provider-default' })
  })

  it.each(['title', 'both'] as const)('returns a source-derived title in %s mode in one call', async (mode) => {
    const body = mode === 'title' ? { what: '', why: '', progress: '', summary: '' } : result
    const expected = { ...body, title: '排查 IBL 问题' }
    const { ctx, adapter } = await harness(JSON.stringify(expected))
    expect(await polishBrief(ctx, policy, { sessionId, text: 'draft', mode }, new AbortController().signal)).toEqual(expected)
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.messages[0]?.content).toEqual([{ type: 'text', text: JSON.stringify({ draft: 'draft', mode, status: 'todo' }) }])
  })

  it.each([
    ['both', result],
    ['both', { ...result, title: ' ' }],
    ['both', { ...result, title: 'x'.repeat(81) }],
    ['polish', { ...result, title: 'Unrequested change' }],
    ['title', { ...result, title: 'Rewrote opted-out body' }],
    ['both', { what: '', why: '', progress: '', summary: '', title: 'Missing description' }],
  ] as const)('rejects output that violates the requested %s editing mode', async (mode, output) => {
    const { ctx, session } = await harness(JSON.stringify(output))
    await expect(polishBrief(ctx, policy, { sessionId, text: 'draft', mode }, new AbortController().signal)).rejects.toThrow()
    expect(vi.mocked(ctx.personalRecords.audit).mock.calls.at(-1)?.[1]).toBe('personal-workbench/brief-polish-request')
  })

  it.each([
    ['malformed', 'not JSON'],
    ['missing section', JSON.stringify({ what: 'Task' })],
    ['oversize summary', JSON.stringify({ ...result, summary: 'x'.repeat(161) })],
    ['extra field', JSON.stringify({ ...result, status: 'done' })],
    ['empty result', JSON.stringify({ what: '', why: '', progress: '', summary: '' })],
    ['oversize result', JSON.stringify({ ...result, what: 'x'.repeat(20_001) })],
  ])('rejects %s output without logging an accepted result', async (_case, text) => {
    const { ctx, session } = await harness(text)
    await expect(polishBrief(ctx, policy, { sessionId, text: 'draft' }, new AbortController().signal)).rejects.toThrow()
    expect(vi.mocked(ctx.personalRecords.audit).mock.calls.at(-1)?.[1]).toBe('personal-workbench/brief-polish-request')
  })

  it('rejects truncated output even if its JSON is complete', async () => {
    const { ctx } = await harness(JSON.stringify(result), { type: 'finish', reason: { kind: 'max-tokens' } })
    await expect(polishBrief(ctx, policy, { sessionId, text: 'draft' }, new AbortController().signal)).rejects.toThrow('complete result')
  })

  it('preserves provider failures without accepting partial output', async () => {
    const { ctx, session } = await harness('', { type: 'finish', reason: { kind: 'error', failure: { code: 'insufficient_balance', message: 'Insufficient Balance' } } })
    await expect(polishBrief(ctx, policy, { sessionId, text: 'draft' }, new AbortController().signal)).rejects.toThrow('Insufficient Balance')
    expect(vi.mocked(ctx.personalRecords.audit).mock.calls.at(-1)?.[1]).toBe('personal-workbench/brief-polish-request')
  })

  it('honors disposal cancellation before dispatch and rejects oversized input before logging', async () => {
    const { ctx, adapter, session } = await harness()
    const controller = new AbortController()
    controller.abort(new Error('Workbench stopping'))
    await expect(polishBrief(ctx, policy, { sessionId, text: 'draft' }, controller.signal)).rejects.toThrow('Workbench stopping')
    await expect(polishBrief(ctx, policy, { sessionId, text: 'x'.repeat(20_001) }, new AbortController().signal)).rejects.toThrow()
    expect(adapter.calls).toHaveLength(0)
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('bounds model transport output', async () => {
    const { ctx } = await harness()
    await expect(polishBrief(ctx, { ...policy, maxOutputBytes: 1 }, { sessionId, text: 'draft' }, new AbortController().signal)).rejects.toThrow('transport limit')
  })
})


it('preserves task images and rejects model output that silently drops them', async () => {
  const image = '![Screenshot](personal-image:v1:fixture)'
  const { ctx } = await harness(JSON.stringify({ ...result, what: result.what + '\n' + image }))
  expect((await polishBrief(ctx, policy, { sessionId, text: 'task\n' + image }, new AbortController().signal)).what).toContain(image)
  const dropped = await harness()
  await expect(polishBrief(dropped.ctx, policy, { sessionId, text: 'task\n' + image }, new AbortController().signal)).rejects.toThrow('screenshot references')
})
