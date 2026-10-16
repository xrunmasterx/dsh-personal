import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { CodeHistory, codeCutoff } from '../src/code-history.ts'
import { CODE_PROMPT } from '../src/code-analysis.ts'
import { codeDiff, codeProject, codePages, codeChanges, type CodeSource } from '../src/code-source.ts'
import { WorkJournal, type JournalId } from '../src/journal.ts'
import { harness } from './helpers.ts'

class Adapter extends LlmAdapter {
  calls = 0
  malformed = 0
  fail = false
  matchTaskId: string | null = null
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.fail) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'offline', code: 'unknown' } } }; return }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.malformed > 0) {
      this.malformed--; yield { type: 'text-delta', index: 0, text: '{not JSON' }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ summary: 'SH sampling changed; runtime validation is not established.', matches: this.matchTaskId ? [{ taskId: this.matchTaskId, summary: 'Sampling implementation changed' }] : [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FixtureSettings extends SettingsProvider {
  readonly writable = true
  protected async load() { return { 'personal-workbench-code': {
    repository: 'https://git.woa.com/example/engine', author: 'demo-user',
    branchPrefix: 'example-project/', validationBranch: 'example-project/dev/car_stable',
    mainBranch: 'example-project/master', checkBranchPrefix: 'example-project/dev/car_check_',
  } } }
  protected async persist() {}
}

async function setup() {
  const h = await harness()
  await h.ctx.plugin(LlmRuntime)
  await h.ctx.plugin(FixtureSettings)
  const adapter = new Adapter()
  const off = h.ctx.llm.registerAdapter(['fixture'], adapter)
  const journal = await WorkJournal.open(h.ctx, 20, 1048576)
  const sha = 'a'.repeat(40)
  const state = { batch: false, main: false, truncated: false, lists: 0, patch: '+ SH sample\n', closes: 0, changed: false, incomplete: false }
  const source: CodeSource = {
    async execute(name, args) {
      let value: unknown
      if (name === 'get_project_detail') value = { id: 183311, path_with_namespace: 'example/engine' }
      else if (name === 'get_branch_list') value = ['example-project/dev/car_stable', 'example-project/master', ...(state.batch ? ['example-project/dev/car_check_20260918'] : [])].map(name => ({ name, commit: { id: ((name === 'example-project/master' && !state.main) || (name === 'example-project/dev/car_stable' && state.batch)) ? 'c'.repeat(40) : state.changed ? 'b'.repeat(40) : sha, committed_date: new Date().toISOString() } }))
      else if (name === 'get_commits_list') {
        if (typeof args.since !== 'string' || !args.since.endsWith('+0000')) throw new Error('Unparseable source date')
        state.lists++
        value = args.ref_name === 'c'.repeat(40) ? [] : [{ id: sha, title: 'SH sampling', message: 'SH sampling', author_name: 'demo-user', author_email: 'demo-user@example.test', committed_date: new Date().toISOString() }]
      } else if (name === 'compare') value = { compare_timeout: state.incomplete, over_flow: false, compare_same_ref: false, commits_total: 1, commits: [{ id: args.to, author_name: 'demo-user', author_email: 'demo-user@example.test' }] }
      else if (name === 'get_commit_info') value = { id: args.commit_sha, title: 'Old cherry pick', message: 'Older work', author_name: 'demo-user', author_email: 'demo-user@example.test', committed_date: '2025-01-01T00:00:00+0000' }
      else if (name === 'get_commit_refs') value = [{ name: state.main ? 'example-project/master' : 'example-project/dev/car_stable' }]
      else if (name === 'get_commit_diff') value = [{ old_path: 'lighting.cpp', new_path: 'lighting.cpp', diff: state.patch, is_too_large: state.truncated }]
      else throw new Error(`Unexpected read ${name}`)
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    },
    async disconnect() { state.closes++ },
  }
  let history: CodeHistory
  async function open() {
    return h.ctx.plugin({ name: 'code-history-fixture', inject: ['storageDomain', 'llm', 'settings'], apply: async (ctx) => {
      history = await CodeHistory.open(ctx, h.config, journal, async () => source)
      history.start()
    } })
  }
  let owner = await open()
  return { h, journal, adapter, state, get history() { return history },
    async reopen() { await history.close(); await owner.dispose(); owner = await open() },
    async close() { await history.close(); await owner.dispose(); await journal.close(); off(); await h.close() } }
}

describe('retained code progress', () => {
  it('does not reanalyze unchanged code after a restart or a stage-only change', async () => {
    const h = await setup()
    try {
      await h.history.sync(false)
      expect(h.history.list(null, null, 0).error).toBeNull()
      expect(h.history.list(null, null, 0).items[0]?.stage).toBe('validation')
      expect(h.adapter.calls).toBe(1)
      const lists = h.state.lists
      await h.reopen()
      h.state.main = true
      await h.history.sync(false)
      expect(h.state.lists).toBe(lists)
      expect(h.adapter.calls).toBe(1)
      const row = h.history.list(null, null, 0).items[0]!
      expect(row.stage).toBe('main')
      expect(row.stageEvents.map(e => e.stage)).toEqual(['validation', 'main'])
      expect(h.history.read(row.id).diff).toContain('SH sample')
      expect(h.state.closes).toBe(2)
    } finally { await h.close() }
  })

  it('recognizes a Car batch after stable resets without requiring a model stage decision', async () => {
    const h = await setup()
    try {
      h.state.batch = true
      await h.history.sync(false)
      const row = h.history.list(null, null, 0).items[0]!
      expect(row.stage).toBe('validation')
      expect(row.branches).toContain('example-project/dev/car_check_20260918')
      expect(row.branches).not.toContain('example-project/dev/car_stable')
      expect(h.adapter.calls).toBe(1)
    } finally { await h.close() }
  })

  it('retains failed analysis independently of the source checkpoint and retries it', async () => {
    const h = await setup()
    try {
      h.adapter.fail = true
      await h.history.sync(false)
      expect(h.history.list(null, null, 0).items[0]?.analysis).toBeNull()
      expect(h.history.list(null, null, 0).items[0]?.error).toBe('offline')
      h.adapter.fail = false
      await h.history.sync(true)
      expect(h.history.list(null, null, 0).items[0]?.analysis?.summary).toContain('SH sampling')
    } finally { await h.close() }
  })

  it('does not spend model quota on a truncated provider patch', async () => {
    const h = await setup()
    try {
      h.state.truncated = true
      await h.history.sync(false)
      expect(h.adapter.calls).toBe(0)
      expect(h.history.list(null, null, 0).items[0]?.error).toContain('omitted')
      h.state.truncated = false
      await h.history.sync(true)
      expect(h.adapter.calls).toBe(1)
    } finally { await h.close() }
  })

  it('analyzes every patch chunk before publishing a combined summary', async () => {
    const h = await setup()
    try {
      h.state.patch = '+'.repeat(25000)
      await h.history.sync(false)
      expect(h.adapter.calls).toBe(3)
      expect(h.history.list(null, null, 0).items[0]?.analysis).not.toBeNull()
    } finally { await h.close() }
  })

  it('discovers old-dated changes by head comparison and reuses identical patches', async () => {
    const h = await setup()
    try {
      await h.history.sync(false)
      h.state.changed = true
      h.state.incomplete = true
      await h.history.sync(false)
      expect(h.history.list(null, null, 0).error).toContain('incomplete')
      expect(h.history.list(null, null, 0).total).toBe(1)
      h.state.incomplete = false
      await h.history.sync(false)
      const page = h.history.list(null, null, 0)
      expect(page.error).toBeNull()
      expect(page.total).toBe(1)
      expect(page.items[0]?.commits).toHaveLength(2)
      expect(page.items[0]?.commits.find(row => row.equivalentTo)?.committedAt).toBe('2025-01-01T00:00:00.000Z')
      expect(h.adapter.calls).toBe(1)
    } finally { await h.close() }
  })

  it('expires only integrated patches while keeping summaries and sources after restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const h = await setup()
    try {
      await h.history.sync(false)
      vi.setSystemTime(new Date('2026-05-02T00:00:00Z'))
      await h.history.sync(false)
      const id = h.history.list(null, null, 0).items[0]!.id
      expect(h.history.read(id).diff).not.toBeNull()
      h.state.main = true
      await h.history.sync(false)
      await h.reopen()
      expect(h.history.read(id)).toMatchObject({ diff: null, diffExpired: true, stage: 'main' })
      expect(h.history.read(id).analysis?.summary).toContain('SH sampling')
      expect(h.history.read(id).url).toContain('/commit/')
      expect(h.adapter.calls).toBe(1)
    } finally { await h.close(); vi.useRealTimers() }
  })

  it('rejects comparisons that omit commits even without a timeout', async () => {
    const source: CodeSource = { execute: async () => ({
      structuredContent: { compare_timeout: false, over_flow: false, compare_same_ref: false, commits_total: 2,
        commits: [] } }), disconnect: async () => {} }
    await expect(codeChanges(source, 'p', 'a', 'b')).rejects.toThrow('incomplete')
  })

  it('exposes matching code in task evidence without completing or rewriting the task', async () => {
    const h = await setup()
    try {
      const itemId = randomUUID() as JournalId
      await h.journal.write({ requestId: randomUUID() as JournalId, itemId, operation: 'create', expectedRevision: 0,
        day: '2026-09-18', title: 'SH sampling', description: 'User-authored plan', status: 'active', reason: 'Fixture task' })
      h.adapter.matchTaskId = itemId
      h.state.main = true
      await h.history.sync(false)
      expect(h.history.list(null, null, 0, itemId).items[0]?.stage).toBe('main')
      const item = h.journal.query({ from: null, to: null, text: '', includeOpen: true, offset: 0 }).items[0]?.item
      expect(item).toMatchObject({ status: 'active', description: 'User-authored plan' })
    } finally { await h.close() }
  })

  it('repairs malformed model JSON once and retains an exhausted failure', async () => {
    const h = await setup()
    try {
      h.adapter.malformed = 1
      await h.history.sync(false)
      expect(h.adapter.calls).toBe(2)
      expect(h.history.list(null, null, 0).items[0]?.analysis).not.toBeNull()
      h.state.changed = true
      h.state.patch = '+ a different change'
      h.adapter.malformed = 3
      await h.history.sync(false)
      expect(h.adapter.calls).toBe(4)
      expect(h.history.list(null, null, 0).items.find(r => r.sha.startsWith('b'))?.error).toBeTruthy()
    } finally { await h.close() }
  })

  it('rejects foreign URLs and reports repeated pagination', async () => {
    expect(codeProject('https://git.woa.com/example/engine')).toBe('example/engine')
    expect(() => codeProject('https://example.com/example/engine')).toThrow()
    const source: CodeSource = {
      execute: async () => ({ structuredContent: Array.from({ length: 100 }, (_, id) => ({ id })) }), disconnect: async () => {} }
    await expect(codePages(source, 'get_commits_list', {}, new AbortController().signal)).rejects.toThrow('repeated')
    expect(codeDiff({ structuredContent: [] })).toBe('')
  })

  it('uses calendar months and snapshots the evidence policy', () => {
    expect(codeCutoff(new Date('2026-05-31T00:00:00Z'), 3).toISOString()).toBe('2026-02-28T00:00:00.000Z')
    expect(CODE_PROMPT).toMatchSnapshot()
  })
})
