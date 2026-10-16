import { HISTORY_PROMPT } from '../src/history-analysis.ts'
import { DatabaseSync } from 'node:sqlite'
import { appendFile, mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { ConversationHistory, historyWindow } from '../src/history.ts'
import { HistoryPolicySchema } from '../src/history-settings.ts'
import { HistoryReaders, historyHash } from '../src/history-readers.ts'
import { analyzeHistory } from '../src/history-analysis.ts'
import { historyAnalysisSchema, historyMessageSchema, type HistoryRecord } from '../src/history-schema.ts'
import { redactHistory } from '../src/history-redaction.ts'
import { historyTaskInput, historyExcerpt } from '../src/history-input.ts'
import { WorkJournal, type JournalId } from '../src/journal.ts'
import { harness } from './helpers.ts'

class MemorySettings extends SettingsProvider {
  get writable() { return true }
  protected async load() { return {} }
  protected async persist(_ns: SettingsNamespace, _section: Record<string, unknown>) {}
}

class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  fail = false
  fenced = false
  rawOutput: string | undefined
  emptyEvidence = false
  longSummary = false
  allEvidence = false
  extraFields = false
  invalidReference: 'task' | 'evidence' | undefined
  gate: (() => Promise<void>) | undefined
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    await this.gate?.()
    if (this.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture failure', code: 'unknown' } } }; return }
    const content = options.messages[0]!.content[0]!
    if (content.type !== 'text') throw new Error('Expected archive JSON')
    const input = JSON.parse(content.text) as {
      tasks: { id: string }[]
      locked: boolean
      fixedTaskIds: string[]
      delta: { id: string }[]
      context: { id: string }[]
    }
    const result = { summary: 'Discussed IBL; validation is pending.', unclassified: !input.tasks.length,
      matches: input.tasks.filter((t: { id: string }) => !input.locked || input.fixedTaskIds.includes(t.id))
        .map((task: { id: string }) => ({
          taskId: task.id, summary: 'IBL changes discussed, not verified.', evidence: this.allEvidence ? input.delta.map(m => m.id) : [(input.delta[0] ?? input.context[0])!.id],
        })) }
    if (this.longSummary) result.summary = '保留真实内容。'.repeat(500)
    if (this.emptyEvidence) for (const match of result.matches) match.evidence = []
    if (this.extraFields) {
      Object.assign(result, { matchesNote: 'Additional explanation', updateConflicts: [] })
      for (const match of result.matches) Object.assign(match, { confidence: 0.9 })
    }
    for (const match of result.matches) {
      if (this.invalidReference === 'task') match.taskId = randomUUID()
      if (this.invalidReference === 'evidence') match.evidence = ['unknown-message']
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.rawOutput ?? (this.fenced ? '```json\n' + JSON.stringify(result) + '\n```' : JSON.stringify(result)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup() {
  const h = await harness()
  const codex = join(h.root, 'codex'); const cursor = join(h.root, 'cursor')
  await mkdir(codex); await mkdir(cursor)
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'))
  db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, source TEXT)')
  const sourceId = randomUUID(); const file = join(codex, 'rollout.jsonl')
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(sourceId, 'IBL discussion', '', h.root, file, Math.floor(Date.now() / 1000), 'vscode')
  db.close()
  const cursorDb = new DatabaseSync(join(cursor, 'state.vscdb'))
  cursorDb.exec('CREATE TABLE composerHeaders (composerId TEXT, value TEXT, isSubagent INTEGER); CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  cursorDb.close()
  await writeFile(file, '')
  const add = async (body: string, role = 'user') => appendFile(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: body }] } }) + '\n')
  await add('Check IBL normalization; not verified yet.')
  const config = h.config
  config.history = HistoryPolicySchema({ ...HistoryPolicySchema(), codexHome: codex, cursorStorage: cursor, stableMs: 0 })
  await h.ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  const off = h.ctx.llm.registerAdapter(['fixture'], adapter)
  const journal = await WorkJournal.open(h.ctx, 20, 1_048_576)
  const history = await ConversationHistory.open(h.ctx, config, journal)
  const taskId = randomUUID() as JournalId
  await journal.write({ requestId: randomUUID() as JournalId, itemId: taskId, expectedRevision: 0, operation: 'create',
    day: new Date().toISOString().slice(0, 10), title: 'IBL normalization', reason: 'Fixture task' })
  return { ...h, config, history, journal, taskId, adapter, file, add, codex, cursor,
    async close() { await history.close(); await journal.close(); off(); await h.close() } }
}

describe('conversation archive', () => {
  it('ranks task details using later messages in the selected batch without privileging old automatic matches', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const taskId = randomUUID() as JournalId
      await h.journal.write({ requestId: randomUUID() as JournalId, itemId: taskId, expectedRevision: 0,
        operation: 'create', day: new Date().toISOString().slice(0, 10), title: 'Workbench screenshot upload',
        description: 'Keep image aspect ratio and support clipboard paste.', reason: 'Fixture task' })
      await h.add('Continue today.')
      await h.add('Workbench screenshot upload needs clipboard paste and image aspect ratio.', 'assistant')
      h.history.sync(false); await h.history.idle()
      const content = h.adapter.calls[1]!.messages[0]!.content[0]!
      if (content.type !== 'text') throw new Error('Expected text')
      const input = JSON.parse(content.text) as { tasks: { id: string; description?: string }[]; delta: { text: string }[] }
      expect(input.delta).toHaveLength(2)
      expect(input.tasks[0]?.id).toBe(taskId)
      expect(input.tasks[0]?.description).toContain('clipboard paste')
      expect({ messages: input.delta.map(m => m.text), topTaskDescription: input.tasks[0]?.description }).toMatchSnapshot()
    } finally { await h.close() }
  })

  it('rotates unfinished conversations after each durable chunk', async () => {
    const h = await setup()
    try {
      await h.add('AlphaConversation '.repeat(2000), 'assistant')
      const file = join(h.codex, 'second.jsonl')
      await writeFile(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'BetaConversation '.repeat(2000) }] } }) + '\n')
      const db = new DatabaseSync(join(h.codex, 'state_5.sqlite'))
      try {
        db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), 'Second conversation', '',
          h.root, file, Math.floor(Date.now() / 1000), 'vscode')
      } finally { db.close() }
      h.history.sync(false); await h.history.idle()
      const order = h.adapter.calls.map((call) => {
        const content = call.messages[0]!.content[0]!
        if (content.type !== 'text') throw new Error('Expected text')
        const input = JSON.parse(content.text) as { delta: { text: string }[] }
        return input.delta.some(m => m.text.includes('AlphaConversation')) ? 'alpha' : 'beta'
      })
      expect(order.length).toBeGreaterThan(4)
      expect(new Set(order.slice(0, 2)).size).toBe(2)
      expect(order[2]).toBe(order[0])
      expect(h.history.list(null, 'all', 0).items.every(card => card.initialComplete && !card.pending && !card.error)).toBe(true)
    } finally { await h.close() }
  })

  it('analyzes every message chunk despite task descriptions exceeding the entire model budget', async () => {
    const h = await setup()
    try {
      const description = 'IBL normalization "quoted" \\shader\n'.repeat(500).trimEnd()
      await h.journal.write({ requestId: randomUUID() as JournalId, itemId: h.taskId, expectedRevision: 1,
        operation: 'update', day: new Date().toISOString().slice(0, 10), description, reason: 'Long retained brief' })
      for (let i = 0; i < 4; i++) await h.journal.write({ requestId: randomUUID() as JournalId,
        itemId: randomUUID() as JournalId, expectedRevision: 0, operation: 'create',
        day: new Date().toISOString().slice(0, 10), title: `IBL task ${i}`, description, reason: 'Additional retained brief' })
      const body = 'Check IBL normalization 中文 \\shader "quoted"\n'.repeat(1800)
      await h.add(body)
      h.adapter.longSummary = true
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(card.initialComplete).toBe(true)
      expect(card.pending).toBe(false)
      const inputs = h.adapter.calls.map((call) => {
        const content = call.messages[0]!.content[0]!
        if (content.type !== 'text') throw new Error('Expected text')
        expect(content.text.length).toBeLessThanOrEqual(54_000)
        return JSON.parse(content.text) as { tasks: { description: string }[]; delta: { text: string; offset: number }[] }
      })
      expect(inputs.length).toBeGreaterThan(2)
      expect(inputs.flatMap(input => input.delta).map(m => m.text).join('')).toBe('Check IBL normalization; not verified yet.' + body.trimEnd())
      expect(inputs[0]!.tasks[0]!.description.length).toBeLessThan(description.length)
      expect(h.journal.query({ from: null, to: null, text: '', offset: 0, includeOpen: true }).items[0]!.item.description).toBe(description)
    } finally { await h.close() }
  })

  it('keeps ranked task identities and description excerpts inside a serialized budget', async () => {
    const h = await setup()
    try {
      const item = h.journal.query({ from: null, to: null, text: '', offset: 0, includeOpen: true }).items[0]!.item
      const items = Array.from({ length: 150 }, (_, i) => ({ ...item, id: randomUUID() as JournalId,
        title: i === 149 ? 'UniqueCubemapBug' : `Unrelated task ${i}`, description: 'Other text '.repeat(1000) + '\n\nUniqueCubemapBug evidence' }))
      const preferred = items[130]!.id
      const result = historyTaskInput(items, 'UniqueCubemapBug', [preferred], 3000)
      expect(JSON.stringify(result.tasks).length).toBeLessThanOrEqual(3000)
      expect(result.tasks[0]!.id).toBe(preferred)
      expect(result.tasks.some(t => t.id === items[149]!.id)).toBe(true)
      expect(result.omittedTasks).toBeGreaterThan(0)
      const details = historyTaskInput(items.slice(-2), 'UniqueCubemapBug', [], 3000)
      expect(details.omittedTasks).toBe(0)
      expect(details.tasks[0]!.description).toContain('UniqueCubemapBug evidence')
      expect(JSON.stringify(details.tasks).length).toBeLessThanOrEqual(3000)
      expect(JSON.stringify(historyExcerpt('中文"\\\n'.repeat(100), 80)).length).toBeLessThanOrEqual(80)
      expect(historyExcerpt('long text', 2)).toBe('')
    } finally { await h.close() }
  })

  it('shows an incomplete record for unreadable source text and recovers without publishing a partial summary', async () => {
    const h = await setup()
    try {
      const original = await readFile(h.file, 'utf8')
      await appendFile(h.file, '{invalid JSON}\n')
      h.history.sync(false); await h.history.idle()
      const incomplete = h.history.list(null, 'all', 0).items[0]!
      expect(incomplete.fullHistory).toBe(false)
      expect(incomplete.sourceError).toBeTruthy()
      expect(incomplete.analysis).toBeNull()
      expect(h.adapter.calls).toHaveLength(0)
      await writeFile(h.file, original)
      h.history.sync(false); await h.history.idle()
      const complete = h.history.list(null, 'all', 0).items[0]!
      expect(complete.fullHistory).toBe(true)
      expect(complete.sourceError).toBeUndefined()
      expect(complete.initialComplete).toBe(true)
    } finally { await h.close() }
  })

  it('reads old Cursor questions when a recent bubble discovers the session and tracks it after the window moves', async () => {
    const h = await setup()
    try {
      const db = new DatabaseSync(join(h.cursor, 'state.vscdb'))
      const old = new Date(Date.now() - 70 * 86400000).toISOString()
      const recent = new Date().toISOString()
      db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 0)').run('full-cursor', JSON.stringify({ name: 'Full Cursor' }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:full-cursor', JSON.stringify({
        fullConversationHeadersOnly: [{ bubbleId: 'old', type: 1, createdAt: old }, { bubbleId: 'new', type: 2, createdAt: recent }] }))
      for (const id of ['old', 'new']) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
        .run(`bubbleId:full-cursor:${id}`, JSON.stringify({ text: id }))
      db.close()
      const reader = new HistoryReaders()
      const policy = HistoryPolicySchema(h.config.history)
      expect((await reader.cursor(h.cursor, historyWindow('week'), policy, new AbortController().signal))[0]?.messages.map(m => m.text))
        .toEqual(['old', 'new'])
      expect(await reader.cursor(h.cursor, Date.now() + 86400000, policy, new AbortController().signal)).toEqual([])
      expect((await reader.cursor(h.cursor, Date.now() + 86400000, policy, new AbortController().signal,
        new Set(['full-cursor'])))[0]?.messages).toHaveLength(2)
    } finally { await h.close() }
  })

  it('classifies Cursor progress only within a turn with a recorded final answer', async () => {
    const h = await setup()
    try {
      const db = new DatabaseSync(join(h.cursor, 'state.vscdb'))
      const at = new Date().toISOString()
      const headers = [
        { bubbleId: 'question', type: 1 }, { bubbleId: 'progress', type: 2 },
        { bubbleId: 'answer', type: 2, grouping: { turnDurationMs: 100 } },
        { bubbleId: 'next-question', type: 1 }, { bubbleId: 'unknown', type: 2 },
      ].map(header => ({ ...header, createdAt: at }))
      db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 0)').run('phases', JSON.stringify({ name: 'Phases' }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:phases', JSON.stringify({ fullConversationHeadersOnly: headers }))
      for (const header of headers) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
        .run(`bubbleId:phases:${header.bubbleId}`, JSON.stringify({ text: header.bubbleId, thinking: 'Excluded thinking' }))
      db.close()
      const result = await new HistoryReaders().cursor(h.cursor, 0, HistoryPolicySchema(h.config.history), new AbortController().signal)
      expect(result[0]?.messages.map(m => [m.text, m.phase])).toEqual([
        ['question', undefined], ['progress', 'progress'], ['answer', 'answer'], ['next-question', undefined], ['unknown', undefined],
      ])
    } finally { await h.close() }
  })

  it('retains Codex progress separately from final answers without including analysis-channel text', async () => {
    const h = await setup()
    try {
      for (const channel of ['analysis', 'commentary', 'final']) await appendFile(h.file, JSON.stringify({
        timestamp: new Date().toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'assistant', channel, content: [{ type: 'output_text', text: channel }] },
      }) + '\n')
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      const messages = [...h.history.read(card.id, 0).messages, ...h.history.read(card.id, 2).messages]
      expect(messages.filter(m => m.role === 'assistant').map(m => [m.text, m.phase])).toEqual([
        ['commentary', 'progress'], ['final', 'answer'],
      ])
      expect(messages.find(m => m.text === 'commentary')?.hash).toBe(historyHash(['assistant', 'commentary']))
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it('discovers by recent activity but archives and initially analyzes messages older than a month', async () => {
    const h = await setup()
    try {
      const old = new Date(Date.now() - 60 * 86400000).toISOString()
      const recent = new Date().toISOString()
      const line = (at: string, role: string, body: string) => JSON.stringify({ timestamp: at, type: 'response_item',
        payload: { type: 'message', role, content: [{ type: 'input_text', text: body }] } }) + '\n'
      await writeFile(h.file, line(old, 'user', 'Original question') + line(old, 'assistant', 'Original answer')
        + line(recent, 'user', 'Continue today'))
      h.adapter.allEvidence = true
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.messageCount).toBe(3)
      expect(card.fullHistory).toBe(true)
      expect(card.initialComplete).toBe(true)
      expect(card.analysis?.matches[0]?.evidence).toHaveLength(3)
      const input = h.adapter.calls[0]!.messages[0]!.content[0]!
      expect(input.type === 'text' && (JSON.parse(input.text) as { delta: { text: string }[] }).delta.map(m => m.text))
        .toEqual(['Original question', 'Original answer', 'Continue today'])
      await h.add('One new answer', 'assistant')
      h.history.sync(false); await h.history.idle()
      const updated = h.adapter.calls[1]!.messages[0]!.content[0]!
      expect(updated.type === 'text' && (JSON.parse(updated.text) as { delta: { text: string }[] }).delta.map(m => m.text))
        .toEqual(['One new answer'])
      const readers = new HistoryReaders()
      expect(await readers.codex(h.codex, Date.now() + 86400000, HistoryPolicySchema(h.config.history), new AbortController().signal))
        .toEqual([])
      const tracked = await readers.codex(h.codex, Date.now() + 86400000, HistoryPolicySchema(h.config.history),
        new AbortController().signal, new Set([card.sourceId]))
      expect(tracked[0]?.messages).toHaveLength(4)
    } finally { await h.close() }
  })

  it('keeps the initial draft unpublished across failure and separates later messages from its target', async () => {
    const h = await setup()
    try {
      await h.add('Long answer '.repeat(2500), 'assistant')
      h.adapter.gate = async () => { h.adapter.fail = h.adapter.calls.length === 2 }
      h.history.sync(false); await h.history.idle()
      const first = h.history.list(null, 'all', 0).items[0]!
      expect(first.analysis).toBeNull()
      expect(first.initialComplete).toBe(false)
      expect(first.progress).toEqual({ completed: 1, total: 2 })
      expect({ progress: first.progress, summary: first.analysis, initialComplete: first.initialComplete }).toMatchSnapshot()
      await h.history.close()
      await h.add('Arrived after the initial snapshot')
      h.adapter.fail = false
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      const observed: (number | undefined)[] = []
      h.adapter.gate = async () => { observed.push(reopened.list(null, 'all', 0).items[0]?.progress?.total) }
      try {
        reopened.sync(true); await reopened.idle()
        expect(observed[0]).toBe(2)
        expect(observed.at(-1)).toBeUndefined()
        const completed = reopened.list(null, 'all', 0).items[0]!
        expect(completed.initialComplete).toBe(true)
        expect(completed.pending).toBe(false)
        expect(completed.messageCount).toBe(3)
      } finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('rebuilds a legacy window-only summary while retaining it until complete', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.close()
      const path = join(h.root, 'storage', 'personal_conversation_archive', 'sessions', card.id + '.json')
      const saved = JSON.parse(await readFile(path, 'utf8')) as { record: HistoryRecord }
      saved.record.fullHistory = false; saved.record.initialComplete = false
      saved.record.messages = []; saved.record.analyzed = {}
      await writeFile(path, JSON.stringify(saved))
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      try {
        h.adapter.gate = async () => { expect(reopened.list(null, 'all', 0).items[0]?.analysis).toEqual(card.analysis) }
        reopened.sync(false); await reopened.idle()
        expect(reopened.list(null, 'all', 0).items[0]?.fullHistory).toBe(true)
        expect(reopened.read(card.id, 0).messages).toHaveLength(1)
      } finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('accepts a complete summary beyond the editorial length target', async () => {
    const h = await setup()
    try {
      h.adapter.longSummary = true
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(card.analysis?.summary).toBe('保留真实内容。'.repeat(500))
      expect(card.pending).toBe(false)
    } finally { await h.close() }
  })

  it('preserves unchanged task evidence and rejects unsupported new associations without blocking the session', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const before = h.history.list(null, 'all', 0).items[0]!.analysis!.matches
      h.adapter.emptyEvidence = true
      await h.add('New topic without task evidence')
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(card.analysis?.matches).toEqual(before)
      expect(card.pending).toBe(false)
    } finally { await h.close() }
    const h2 = await setup()
    try {
      h2.adapter.emptyEvidence = true
      h2.history.sync(false); await h2.history.idle()
      expect(h2.history.list(null, 'all', 0).items[0]).toMatchObject({ error: null, pending: false,
        taskIds: [], analysis: { matches: [], unclassified: true } })
    } finally { await h2.close() }
  })

  it('repairs missing result fields with validation feedback and bounds failed attempts', async () => {
    const h = await setup()
    try {
      h.adapter.rawOutput = '{"summary":"incomplete"}'
      h.adapter.gate = async () => { if (h.adapter.calls.length === 2) h.adapter.rawOutput = undefined }
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(2)
      expect(JSON.stringify(h.adapter.calls[1]?.messages)).toContain('correction')
      expect(h.history.list(null, 'all', 0).items[0]).toMatchObject({ pending: false, error: null })
      await h.add('Another question')
      h.adapter.gate = undefined; h.adapter.rawOutput = 'invalid JSON'
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(4)
      expect(h.history.list(null, 'all', 0).items[0]?.error).toBeTruthy()
    } finally { await h.close() }
  })

  it('excludes tool calls and outputs from retention and analysis, including tool-only updates', async () => {
    const h = await setup()
    const body = 'passed diagnostics '.repeat(60000)
    try {
      await appendFile(h.file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
        payload: { type: 'function_call_output', output: body } }) + '\n')
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(h.history.read(card.id, 0).messages.map(m => m.text)).toEqual(['Check IBL normalization; not verified yet.'])
      expect(card.pending).toBe(false)
      expect(h.adapter.calls).toHaveLength(1)
      const content = h.adapter.calls[0]!.messages[0]!.content[0]!
      if (content.type !== 'text') throw new Error('Expected analysis request')
      const input = JSON.parse(content.text) as { delta: { role: string; text: string; truncated: boolean }[] }
      expect(input.delta).toHaveLength(1)
      expect(historyMessageSchema.safeParse({ ...input.delta[0], role: 'evidence' }).success).toBe(false)
      expect(content.text).not.toContain('passed diagnostics')
      await appendFile(h.file, [
        { type: 'function_call', arguments: '{"command":"private tool arguments"}' },
        { type: 'custom_tool_call_output', output: body },
      ].map(payload => JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload }) + '\n').join(''))
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it('preserves summaries and analysis progress when removed material leaves no citations', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.close()
      const path = join(h.root, 'storage', 'personal_conversation_archive', 'sessions', card.id + '.json')
      const saved = JSON.parse(await readFile(path, 'utf8')) as { record: HistoryRecord }
      saved.record.analysis!.matches[0]!.evidence = []
      await writeFile(path, JSON.stringify(saved))
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      try {
        reopened.sync(false); await reopened.idle()
        expect(h.adapter.calls).toHaveLength(1)
        expect(reopened.list(null, 'all', 0).items[0]).toMatchObject({ taskIds: card.taskIds,
          pending: false, analysis: saved.record.analysis })
        h.adapter.emptyEvidence = true
        await h.add('An unrelated follow-up')
        reopened.sync(false); await reopened.idle()
        expect(reopened.list(null, 'all', 0).items[0]).toMatchObject({ taskIds: card.taskIds,
          pending: false, analysis: { matches: saved.record.analysis!.matches } })
      } finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('backfills previously clipped text and reanalyzes the missing content', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.close()
      const path = join(h.root, 'storage', 'personal_conversation_archive', 'sessions', card.id + '.json')
      const saved = JSON.parse(await readFile(path, 'utf8')) as { record: HistoryRecord }
      saved.record.messages[0]!.text = 'Check'
      saved.record.messages[0]!.truncated = true
      await writeFile(path, JSON.stringify(saved))
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      try {
        reopened.sync(false); await reopened.idle()
        expect(reopened.read(card.id, 0).messages[0]?.text).toBe('Check IBL normalization; not verified yet.')
        expect(reopened.read(card.id, 0).messages[0]?.truncated).toBe(false)
        const request = h.adapter.calls[1]!.messages[0]!.content[0]!
        expect(request.type === 'text' && (JSON.parse(request.text) as { delta: { offset: number }[] }).delta[0]?.offset).toBe(5)
        expect(h.adapter.calls).toHaveLength(2)
        reopened.sync(false); await reopened.idle()
        expect(h.adapter.calls).toHaveLength(2)
      } finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('retains full answers, excludes reasoning and resumes long-message chunks after reopening', async () => {
    const h = await setup()
    const answer = '完整回答。'.repeat(6000)
    try {
      await h.add(answer, 'assistant')
      await appendFile(h.file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } }) + '\n')
      h.adapter.gate = async () => { h.adapter.fail = h.adapter.calls.length === 2 }
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(h.history.read(card.id, 0).messages.map(m => m.text)).toEqual(['Check IBL normalization; not verified yet.', answer])
      expect(h.history.read(card.id, 0).messages.every(m => !m.truncated)).toBe(true)
      expect(card.error).toBe('fixture failure')
      await h.history.close()
      h.adapter.gate = undefined; h.adapter.fail = false
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      try {
        reopened.sync(true); await reopened.idle()
        const resumed = h.adapter.calls[2]!.messages[0]!.content[0]!
        expect(resumed.type === 'text' && (JSON.parse(resumed.text) as { delta: { offset: number }[] }).delta[0]?.offset).toBe(12000)
        expect(reopened.list(null, 'all', 0).items[0]?.pending).toBe(false)
        const calls = h.adapter.calls.length
        reopened.sync(false); await reopened.idle()
        expect(h.adapter.calls).toHaveLength(calls)
        expect(JSON.stringify(h.adapter.calls)).not.toContain('private reasoning')
      } finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('preserves more than twenty citations and merges subsequent evidence without replaying old IDs', async () => {
    const h = await setup()
    try {
      h.adapter.allEvidence = true
      for (let i = 0; i < 24; i++) await h.add(`IBL evidence ${i}`)
      h.history.sync(false); await h.history.idle()
      let card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(card.analysis?.matches[0]?.evidence).toHaveLength(25)
      await h.add('New IBL evidence')
      h.history.sync(false); await h.history.idle()
      card = h.history.list(null, 'all', 0).items[0]!
      expect(card.analysis?.matches[0]?.evidence).toHaveLength(26)
      const request = h.adapter.calls[1]!.messages[0]!.content[0]!
      expect(request.type === 'text' && (JSON.parse(request.text) as { previous: { matches: { evidence: string[] }[] } }).previous.matches[0]?.evidence).toBeUndefined()
      expect({ evidenceCount: card.analysis?.matches[0]?.evidence.length, pending: card.pending, error: card.error }).toMatchSnapshot()
    } finally { await h.close() }
  })

  it.each(['task', 'evidence'] as const)('rejects unknown %s references even with extra model fields', async (reference) => {
    const h = await setup()
    try {
      h.adapter.extraFields = true
      h.adapter.invalidReference = reference
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBe('History model returned unknown or duplicate task/evidence references')
      expect(card.analysis).toBeNull()
      expect(card.pending).toBe(true)
    } finally { await h.close() }
  })

  it('strips extra model fields before saving and advances the incremental checkpoint', async () => {
    const h = await setup()
    try {
      h.adapter.extraFields = true
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(card.pending).toBe(false)
      expect(card.analysis).toEqual({ summary: 'Discussed IBL; validation is pending.', unclassified: false,
        matches: [{ taskId: h.taskId, summary: 'IBL changes discussed, not verified.', evidence: [expect.any(String)] }] })
      expect({ ...card.analysis, matches: card.analysis?.matches.map(match => ({ ...match,
        taskId: '<task-id>', evidence: ['<message-id>'] })) }).toMatchSnapshot()
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it.each([
    { summary: undefined }, { summary: '' }, { unclassified: 'true' },
    { matches: [{ taskId: 'invalid', summary: 'Summary', evidence: ['message-1'] }] },
    { matches: [{ taskId: '11111111-1111-4111-8111-111111111111', summary: 'Summary', evidence: [42] }] },
  ])('rejects invalid required analysis fields despite extra fields: %j', (invalid) => {
    expect(historyAnalysisSchema.safeParse({ summary: 'Summary', unclassified: true, matches: [],
      matchesNote: 'Extra explanation', updateConflicts: [], ...invalid }).success).toBe(false)
  })

  it('searches before paging and keeps scan health independent of list filters', async () => {
    const h = await setup()
    try {
      const secondId = randomUUID()
      const secondFile = join(h.codex, 'other.jsonl')
      await writeFile(secondFile, JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Another conversation' }] } }) + '\n')
      const db = new DatabaseSync(join(h.codex, 'state_5.sqlite'))
      db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(secondId, 'Unique older discussion', '', h.root, secondFile, Date.now() / 1000, 'vscode')
      db.close()
      h.config.pageSize = 1
      h.adapter.fail = true
      h.history.sync(false); await h.history.idle()
      const filtered = h.history.list(null, 'all', 0, 'UNIQUE', 'codex')
      expect(filtered.total).toBe(1)
      expect(filtered.items[0]?.sourceId).toBe(secondId)
      const noMatches = h.history.list(null, 'all', 0, 'UNIQUE', 'cursor')
      expect(noMatches.total).toBe(0)
      expect(noMatches.failedCount).toBe(2)
      expect(h.adapter.calls).toHaveLength(2)
    } finally { await h.close() }
  })

  it('records tool-free model input before execution and the completed summary afterwards', async () => {
    const h = await setup()
    const events: unknown[][] = []
    try {
      h.adapter.gate = async () => { expect(events).toHaveLength(1) }
      const result = await analyzeHistory(h.ctx, h.config.briefPolish,
        { enabled: true, codex: true, cursor: true, intervalMinutes: 60, lookback: 'week',
          model: { provider: 'fixture', model: 'archive' } },
        JSON.stringify({ tasks: [], locked: false, fixedTaskIds: [], delta: [{ id: 'message-1', text: 'Discuss IBL' }], context: [] }),
        async (value) => { events.push(JSON.parse(value) as unknown[]) }, new AbortController().signal)
      expect(events.map(batch => batch.length)).toEqual([1, 2])
      expect({ system: h.adapter.calls[0]?.system, messages: h.adapter.calls[0]?.messages.map(message => message.content),
        tools: h.adapter.calls[0]?.tools, result }).toMatchSnapshot()
    } finally { await h.close() }
  })

  it('reschedules saved intervals, snapshots the independent model and stops timers on disposal', async () => {
    const h = await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      await h.ctx.plugin(MemorySettings)
      h.history.start()
      await vi.waitFor(() =>{  expect(h.ctx.settings.get('personal-workbench-history')).toMatchObject({ intervalMinutes: 60 }) })
      await h.history.idle()
      expect(h.ctx.settings.get('personal-workbench-history')).toMatchObject({ intervalMinutes: 60 })
      await h.ctx.settings.update('personal-workbench-history', { intervalMinutes: 15, model: { provider: 'fixture', model: 'chosen' } })
      expect(Date.parse(h.history.list(null, 'all', 0).nextScan!) - Date.now()).toBe(15 * 60_000)
      await h.add('New verification result')
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await h.history.idle()
      expect(h.adapter.calls.at(-1)?.model).toBe('chosen')
      const count = h.adapter.calls.length
      await vi.advanceTimersByTimeAsync(15 * 60_000)
      await h.history.idle()
      expect(h.adapter.calls).toHaveLength(count)
      await h.history.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers(); await h.close() }
  })

  it('does not spend a model request acknowledging injected environment instructions', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      await appendFile(h.file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n')
      await h.add('<environment_context>updated</environment_context>')
      await h.add('I will follow the updated instructions.', 'assistant')
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it('joins simultaneous sync requests and retains manual changes when the old call fails', async () => {
    const h = await setup()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.adapter.gate = async () => { entered(); await gate }
    h.adapter.fail = true
    try {
      h.history.sync(false); await waiting; h.history.sync(false)
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [h.taskId], ignored: false })
      release(); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
      expect(h.history.list(null, 'all', 0).items[0]?.error).toBeNull()
      expect(h.history.list(null, 'all', 0).items[0]?.locked).toBe(true)
    } finally { release(); await h.close() }
  })
  it('analyzes only changed messages, preserves progress across reopen, and ignores metadata', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.taskIds).toEqual([h.taskId]); expect(card.pending).toBe(false)
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(1)
      await h.add('<environment_context>updated</environment_context>')
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(1)
      await h.add('The test passed.', 'assistant')
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(2)
      const block = h.adapter.calls[1]!.messages[0]!.content[0]!
      expect(block.type === 'text' && (JSON.parse(block.text) as { delta: unknown[] }).delta).toHaveLength(1)
      await h.history.close()
      const reopened = await ConversationHistory.open(h.ctx, h.config, h.journal)
      try {
        reopened.sync(false); await reopened.idle()
        expect(h.adapter.calls).toHaveLength(2); expect(reopened.read(card.id, 0).messages).toHaveLength(2)
      }
      finally { await reopened.close() }
    } finally { await h.close() }
  })

  it('restores automatic associations without pinning them or requesting another analysis', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const before = h.history.list(null, 'all', 0).items[0]!
      expect(before.locked).toBe(false)
      expect(before.taskIds).toEqual([h.taskId])
      await h.history.rule({ id: before.id, revision: before.revision, taskIds: before.taskIds, ignored: true })
      expect(h.history.list(h.taskId, 'all', 0).items).toEqual([])
      const removed = h.history.list(null, 'ignored', 0).items[0]!
      await h.history.rule({ id: removed.id, revision: removed.revision, taskIds: removed.taskIds, ignored: false })
      expect(h.history.list(null, 'all', 0).items[0]).toEqual({ ...before, revision: before.revision + 2 })
      h.history.sync(false); await h.history.idle()
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it('locks manual associations and persists ignore/restore with revision checks', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      let card = h.history.list(null, 'all', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [h.taskId], ignored: false })
      await expect(h.history.rule({ id: card.id, revision: card.revision, taskIds: [], ignored: true })).rejects.toThrow('changed')
      card = h.history.list(null, 'all', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [h.taskId], ignored: true })
      await h.add('More discussion')
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(1)
      card = h.history.list(null, 'ignored', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [h.taskId], ignored: false })
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(2)
      expect(h.history.list(h.taskId, 'all', 0).items[0]?.locked).toBe(true)
    } finally { await h.close() }
  })

  it('retains failed input for explicit retry without changing successful progress', async () => {
    const h = await setup()
    try {
      h.adapter.fail = true; h.history.sync(false); await h.history.idle()
      expect(h.history.list(null, 'all', 0).items[0]?.error).toBeTruthy()
      h.adapter.fail = false; h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(1)
      h.history.sync(true); await h.history.idle(); expect(h.adapter.calls).toHaveLength(2)
      expect(h.history.list(null, 'all', 0).items[0]?.pending).toBe(false)
    } finally { await h.close() }
  })

  it('does not overwrite a human correction made while a model request is in flight', async () => {
    const h = await setup()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.adapter.gate = async () => { entered(); await gate }
    try {
      h.history.sync(false); await waiting
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [], ignored: true })
      release(); await h.history.idle()
      expect(h.history.list(null, 'ignored', 0).items[0]?.analysis).toBeNull()
    } finally { release(); await h.close() }
  })

  it('finds Cursor bubbles despite a stale header timestamp and skips subagents', async () => {
    const h = await setup()
    try {
      const db = new DatabaseSync(join(h.cursor, 'state.vscdb'))
      const at = new Date().toISOString()
      db.prepare('INSERT INTO composerHeaders VALUES (?, ?, 0)').run('cursor-session', JSON.stringify({ name: 'Normalization', lastUpdatedAt: 1 }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:cursor-session', JSON.stringify({ fullConversationHeadersOnly: ['a', 'b', 'c', 'd'].map((bubbleId, index) => ({ bubbleId, type: index === 0 ? 1 : 2, createdAt: at })) }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:cursor-session:a', JSON.stringify({ text: 'IBL normalization question'.repeat(1000), thinking: 'private thinking' }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:cursor-session:b', JSON.stringify({ text: '```ts\nconst result = 1\n```'.repeat(1000), thinking: 'private reasoning', toolFormerData: { result: 'private tool output' } }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:cursor-session:c', JSON.stringify({ toolFormerData: { result: 'passed private tool output', params: 'private arguments' } }))
      db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:cursor-session:d', JSON.stringify({ thinking: 'private reasoning only' }))
      db.close()
      const sessions = await new HistoryReaders().cursor(h.cursor, Date.now() - 60_000,
        HistoryPolicySchema(h.config.history), new AbortController().signal)
      expect(sessions[0]?.messages[0]?.text).toBe('IBL normalization question'.repeat(1000))
      expect(sessions[0]?.messages.map(m => m.role)).toEqual(['user', 'assistant'])
      expect(sessions[0]?.messages[1]?.text).toBe('```ts\nconst result = 1\n```'.repeat(1000))
      expect(JSON.stringify(sessions)).not.toContain('private')
      const writer = new DatabaseSync(join(h.cursor, 'state.vscdb'))
      writer.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(JSON.stringify({ generatingBubbleIds: ['a'], fullConversationHeadersOnly: [{ bubbleId: 'a', type: 1, createdAt: at }] }), 'composerData:cursor-session')
      writer.close()
      expect(await new HistoryReaders().cursor(h.cursor, Date.now() - 60_000,
        HistoryPolicySchema(h.config.history), new AbortController().signal)).toEqual([])
    } finally { await h.close() }
  })


  it('refreshes a manual task summary from retained context without replaying the transcript', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const otherId = randomUUID() as JournalId
      await h.journal.write({ requestId: randomUUID() as JournalId, itemId: otherId, expectedRevision: 0, operation: 'create',
        day: new Date().toISOString().slice(0, 10), title: 'IBL follow-up', reason: 'Fixture task' })
      const card = h.history.list(null, 'all', 0).items[0]!
      await h.history.rule({ id: card.id, revision: card.revision, taskIds: [otherId], ignored: false })
      h.history.sync(false); await h.history.idle()
      const block = h.adapter.calls[1]!.messages[0]!.content[0]!
      expect(block.type === 'text' && (JSON.parse(block.text) as { delta: unknown[] }).delta).toEqual([])
      expect(h.history.list(otherId, 'all', 0).items[0]?.analysis?.matches[0]?.taskId).toBe(otherId)
      h.history.sync(false); await h.history.idle(); expect(h.adapter.calls).toHaveLength(2)
    } finally { await h.close() }
  })

  it('retains the summary and filtered transcript when the original disappears', async () => {
    const h = await setup()
    try {
      h.history.sync(false); await h.history.idle()
      const before = h.history.list(null, 'all', 0).items[0]!
      await unlink(h.file)
      h.history.sync(false); await h.history.idle()
      const after = h.history.list(null, 'all', 0).items[0]!
      expect(after.available).toBe(false); expect(after.analysis).toEqual(before.analysis)
      expect(h.history.read(after.id, 0).messages).toHaveLength(1)
      expect(h.adapter.calls).toHaveLength(1)
    } finally { await h.close() }
  })

  it('redacts recognized keys before retention and model input and accepts a single JSON fence', async () => {
    const h = await setup()
    const key = 'sk-' + 'fake-key-for-test-only-123456789'
    try {
      h.adapter.fenced = true
      await h.add('API_KEY=' + key)
      h.history.sync(false); await h.history.idle()
      const card = h.history.list(null, 'all', 0).items[0]!
      expect(card.error).toBeNull()
      expect(JSON.stringify(h.history.read(card.id, 0))).not.toContain(key)
      expect(JSON.stringify(h.adapter.calls)).not.toContain(key)
      expect(redactHistory('password: pretend-secret')).toBe('password: [redacted]')
    } finally { await h.close() }
  })

  it('clamps calendar month lookback and starts weeks on Monday', () => {
    expect(new Date(historyWindow('month', new Date(2026, 2, 31))).getDate()).toBe(28)
    expect(new Date(historyWindow('week', new Date(2026, 8, 9))).getDay()).toBe(1)
  })
})

it('records the structured, evidence-qualified incremental summary policy', () => {
  expect(HISTORY_PROMPT).toMatchSnapshot()
})
