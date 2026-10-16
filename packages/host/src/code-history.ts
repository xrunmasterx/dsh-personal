/** One durable code archive: source discovery, resumable analysis and read-only retrospective evidence. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ReadOnlyMcp, mcpPayload } from './connectors/mcp.ts'
import { CODE_READS, codeProject, codePages, codeChanges, codeDiff, sourceCommitSchema, type CodeSource } from './code-source.ts'
import { codeRecordSchema, codeSettingsSchema, type CodeSettings, type CodeRecord, type CodeId, type CodePage } from './code-schema.ts'
import { CodePolicySchema, CodePreferenceSchema } from './code-settings.ts'
import { codeGroups, codePatchHash } from './code-groups.ts'
import { analyzeCode } from './code-analysis.ts'
import type { Config } from './config.ts'
import type { WorkJournal, JournalItem } from './journal.ts'

const archive = defineDomain({ name: 'personal_code_archive', version: 1, layout: 'per-record', tables: {
  commits: domainTable<CodeId, CodeRecord>(codeRecordSchema),
  heads: domainTable<string, { sha: string; since: string }>(z.object({ sha: z.string(), since: z.string() })),
  audit: domainTable<string, { codeId: string; events: string }>(z.object({ codeId: z.string(), events: z.string() })),
} })

/**
 * Compute the retention cutoff in calendar months, clamping month-end dates.
 * @param now Current time.
 * @param months Retained calendar months.
 * @returns Inclusive retention boundary.
 */
export function codeCutoff(now: Date, months: number): Date {
  const date = new Date(now); const day = date.getDate()
  date.setDate(1); date.setMonth(date.getMonth() - months)
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()))
  return date
}

/** Shared business owner; reads do not collect or call a model. */
export class CodeHistory {
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | null = null
  private error: string | null = null
  private lastScan: string | null = null
  private readonly policy: ReturnType<typeof CodePolicySchema>
  private settings: CodeSettings

  private constructor(private readonly ctx: Context, private readonly config: Config, private readonly journal: WorkJournal,
    private readonly domain: Domain<typeof archive>, private readonly connect: (signal: AbortSignal) => Promise<CodeSource>) {
    this.policy = CodePolicySchema(config.code)
    this.settings = { enabled: false, repository: '', author: '',
      branchPrefix: '', validationBranch: '', mainBranch: 'main', checkBranchPrefix: '',
      lookbackDays: 7, intervalMinutes: 60, retentionMonths: 3,
      model: { provider: config.briefPolish.provider, model: config.briefPolish.model },
    }
  }

  /**
   * Open durable evidence without starting network work.
   * @param ctx Native storage, credentials and models.
   * @param config Deployment policy.
   * @param journal Current task reader.
   * @param connect Optional source provider for composition tests.
   * @returns Owner requiring awaited close.
   */
  static async open(ctx: Context, config: Config, journal: WorkJournal,
    connect?: (signal: AbortSignal) => Promise<CodeSource>): Promise<CodeHistory> {
    const policy = CodePolicySchema(config.code)
    return new CodeHistory(ctx, config, journal, await ctx.storageDomain.open(archive), connect ?? (async (signal) => {
      const token = (await ctx.credentials.resolve(credentialRef(policy.tokenRef)))?.value
      if (!token) throw new Error(`Configure the Gongfeng credential (${policy.tokenRef})`)
      return ReadOnlyMcp.open({ url: policy.url, headers: { Authorization: `Bearer ${token}` }, timeoutMs: config.toolTimeoutMs, signal }, CODE_READS)
    }))
  }

  /** Install live preferences; disabled archives perform no background reads. */
  start(): void {
    this.ctx.inject(['settings'], (ctx) => {
      let source = () => this.settings
      ctx.settings.installSection(this.ctx, 'personal-workbench-code', CodePreferenceSchema, this.settings, {
        setSource: (current) => { source = current; this.settings = codeSettingsSchema.parse(source()); this.schedule() },
        onChange: () => { this.settings = codeSettingsSchema.parse(source()); this.schedule() },
      })
      if (this.settings.enabled) void this.sync(false)
    })
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (!this.settings.enabled || this.lifetime.signal.aborted) return
    this.timer = setTimeout(() => { void this.sync(false) }, this.settings.intervalMinutes * 60000)
    this.timer.unref()
  }

  /**
   * Join or start one scan; failed analysis is retained and retried within the configured budget.
   * @param retry Reset exhausted analysis attempts.
   * @returns Settled background pass; errors are exposed by list.
   */
  sync(retry: boolean): Promise<void> {
    if (this.running) return this.running
    if (this.lifetime.signal.aborted) return Promise.resolve()
    clearTimeout(this.timer)
    const settings = structuredClone(this.settings)
    this.running = this.run(settings, retry).catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.error = error instanceof Error ? error.message : String(error)
    }).finally(() => { this.running = null; this.schedule() })
    return this.running
  }

  /**
   * Read retained summaries by occurrence or integration-observation date.
   * @param from Inclusive ISO timestamp, or null.
   * @param to Exclusive ISO timestamp, or null.
   * @param offset Page offset.
   * @param taskId Optional associated task.
   * @returns Bounded records and synchronization health.
   */
  list(from: string | null, to: string | null, offset: number, taskId?: string): CodePage {
    z.number().int().nonnegative().parse(offset)
    if (from !== null) z.iso.datetime({ offset: true }).parse(from)
    if (to !== null) z.iso.datetime({ offset: true }).parse(to)
    if (taskId !== undefined) z.uuid().parse(taskId)
    const records = [...this.domain.table('commits').entries()].map(([, r]) => r)
    const all = codeGroups(records).filter(r =>
      (!taskId || r.analysis?.matches.some(m => m.taskId === taskId)) &&
      [...r.commits.map(c => c.committedAt), ...r.stageEvents.map(e => e.observedAt)].some(at =>
        (!from || Date.parse(at) >= Date.parse(from)) && (!to || Date.parse(at) < Date.parse(to))))
      .sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    const end = offset + this.config.pageSize
    return { items: all.slice(offset, end), total: all.length,
      nextOffset: end < all.length ? end : null, running: this.running !== null, lastScan: this.lastScan, error: this.error }
  }

  /**
   * Read the retained patch without calling the source or model.
   * @param id Identity returned by list.
   * @returns Record, including explicit patch-expiration state.
   */
  read(id: CodeId): CodeRecord {
    const record = this.domain.table('commits').get(id)
    if (!record) throw new Error('Code record not found')
    return structuredClone(record)
  }

  private tasks(): JournalItem[] {
    const tasks: JournalItem[] = []; let offset: number | null = 0
    while (offset !== null) {
      const page = this.journal.query({ from: null, to: null, text: '', offset, includeOpen: true })
      tasks.push(...page.items.map(row => row.item)); offset = page.nextOffset
    }
    return tasks
  }

  private async run(settings: CodeSettings, retry: boolean): Promise<void> {
    this.error = null
    const signal = this.lifetime.signal
    const source = await this.connect(signal)
    try {
      const project = z.object({ id: z.number(), path_with_namespace: z.string() }).parse(mcpPayload(await source.execute('get_project_detail', { project_id: codeProject(settings.repository) })))
      const projectId = String(project.id)
      const branches = z.array(z.object({ name: z.string(), commit: z.object({ id: z.string(), committed_date: z.string() }) })).parse(
        await codePages(source, 'get_branch_list', { project_id: projectId, search: settings.branchPrefix }, signal))
        .filter(b => b.name.startsWith(settings.branchPrefix))
      for (const required of [settings.validationBranch, settings.mainBranch]) {
        if (!branches.some(b => b.name === required)) throw new Error(`Required branch is not in the scanned scope: ${required}`)
      }
      const commits = this.domain.table('commits')
      const initialSince = new Date(Date.now() - settings.lookbackDays * 86400000).toISOString()
      const reads = new Map<string, unknown[]>()
      const cutoff = codeCutoff(new Date(), settings.retentionMonths).toISOString()
      for (const branch of branches) {
        const key = createHash('sha256').update(JSON.stringify([projectId, settings.author, branch.name])).digest('hex')
        if (this.domain.table('heads').get(key)?.sha === branch.commit.id) continue
        const saved = this.domain.table('heads').get(key)
        const since = saved?.since ?? initialSince
        if (!saved && Date.parse(branch.commit.committed_date) < Date.parse(since)) {
          await this.domain.table('heads').put(key, { sha: branch.commit.id, since })
          continue
        }
        const readKey = JSON.stringify([saved?.sha, branch.commit.id, since])
        let rows = reads.get(readKey)
        if (!rows) rows = saved ? await codeChanges(source, projectId, saved.sha, branch.commit.id) : await codePages(source, 'get_commits_list', {
          project_id: projectId, ref_name: branch.commit.id, since: since.replace(/\.\d{3}Z$/, '+0000'),
        }, signal)
        reads.set(readKey, rows)
        for (const raw of rows) {
          const candidate = z.object({ id: z.string(), author_name: z.string(), author_email: z.string() }).parse(raw)
          if (candidate.author_name !== settings.author && candidate.author_email !== settings.author && candidate.author_email.split('@')[0] !== settings.author) continue
          const row = sourceCommitSchema.parse(saved ? mcpPayload(await source.execute('get_commit_info', { project_id: projectId, commit_sha: candidate.id })) : raw)
          if (row.author_name !== settings.author && row.author_email !== settings.author && row.author_email.split('@')[0] !== settings.author) continue
          const id = `${projectId}_${row.id}` as CodeId
          const existing = commits.get(id)
          const observed = existing?.branches ?? []
          if (existing) {
            if (!observed.includes(branch.name)) await commits.put(id, { ...existing, branches: [...observed, branch.name] })
            continue
          }
          await commits.put(id, { id, project: projectId, sha: row.id, title: row.title, message: row.message, author: row.author_email,
            committedAt: new Date(row.committed_date).toISOString(), discoveredAt: new Date().toISOString(), url: `https://git.woa.com/${project.path_with_namespace}/commit/${row.id}`,
            branches: [branch.name], stage: 'development', stageEvents: [],
            patchHash: null, equivalentTo: null, sourceSha: /cherry picked from commit ([a-f0-9]{7,64})/i.exec(row.message)?.[1] ?? null,
            diff: null, diffExpired: false, chunks: [], analysis: null, analyzedAt: null, error: null, attempts: 0 })
        }
        await this.domain.table('heads').put(key, { sha: branch.commit.id, since })
      }
      const tasks = this.tasks()
      const taskIds = new Set<string>(tasks.map(t => t.id))
      for (const [id, initial] of commits.entries()) {
        if (initial.project !== projectId) continue
        signal.throwIfAborted()
        let record = initial
        try {
          const names = record.branches
          const observedMain = record.stageEvents.some(e => e.stage === 'main')
          const observedCar = record.stageEvents.some(e => e.stage === 'validation')
          const stage = observedMain || names.includes(settings.mainBranch) ? 'main'
            : observedCar || names.includes(settings.validationBranch) || (settings.checkBranchPrefix && names.some(n => n.startsWith(settings.checkBranchPrefix))) ? 'validation' : 'development'
          record = { ...record, branches: names, stage, error: record.analysis ? null : record.error,
            stageEvents: record.stageEvents.at(-1)?.stage === stage
              ? record.stageEvents : [...record.stageEvents, { stage, observedAt: new Date().toISOString() }],
          }
          await commits.put(id, record)
          if (!record.analysis && (retry || record.attempts < this.policy.maxAttempts)) {
            if (record.diff === null) {
              const diff = codeDiff(await source.execute('get_commit_diff', { project_id: projectId, sha: record.sha }))
              record = { ...record, diff, patchHash: codePatchHash(diff) }
              await commits.put(id, record)
            }
            const diff = record.diff
            assert(diff !== null)
            const same = [...commits.entries()].map(([, r]) => r).find(r =>
              r.id !== id && r.project === projectId && r.analysis && diff.length > 0 &&
              (r.diff ? codePatchHash(r.diff) : r.patchHash) === record.patchHash)
            if (same?.analysis) record = { ...record,
              equivalentTo: same.equivalentTo ?? same.id, analysis: same.analysis, analyzedAt: new Date().toISOString(), error: null }
            else {
              const count = Math.max(1, Math.ceil(diff.length / this.policy.chunkChars))
              const analyze = async (data: unknown) => {
                const input = JSON.stringify({ title: record.title, message: record.message,
                  tasks: tasks.map(t => ({ id: t.id, title: t.title, description: t.description })), ...data as object })
                if (input.length > this.policy.maxInputChars) throw new Error('Code analysis input exceeds the configured limit; no source text was truncated')
                return analyzeCode(this.ctx, this.config.briefPolish, settings, input, taskIds,
                  async (auditId, events) => { await this.domain.table('audit').put(auditId, { codeId: id, events }) }, signal, { remaining: this.policy.repairAttempts, maxInputChars: this.policy.maxInputChars })
              }
              for (let part = record.chunks.length; part < count; part++) {
                const result = await analyze({ part: part + 1, total: count,
                  diff: diff.slice(part * this.policy.chunkChars, (part + 1) * this.policy.chunkChars) })
                record = { ...record, chunks: [...record.chunks, result] }; await commits.put(id, record)
              }
              const analysis = count === 1 ? record.chunks[0] : await analyze({ merge: true, parts: record.chunks })
              assert(analysis)
              record = { ...record, analysis, analyzedAt: new Date().toISOString(), error: null }
            }
            await commits.put(id, record)
          }
          if (record.analysis && record.stage === 'main' && record.discoveredAt < cutoff && record.diff !== null) {
            await commits.put(id, { ...record, diff: null, diffExpired: true, chunks: [] })
            for (const [auditId, entry] of this.domain.table('audit').entries()) {
              if (entry.codeId === id) await this.domain.table('audit').delete(auditId)
            }
          }
        } catch (error) {
          signal.throwIfAborted()
          await commits.put(id, { ...record, attempts: record.attempts + 1, error: error instanceof Error ? error.message : String(error) })
        }
      }
      this.lastScan = new Date().toISOString()
    } finally { await source.disconnect() }
  }

  /** Stop scheduling and await active source/model work before releasing storage. */
  async close(): Promise<void> {
    clearTimeout(this.timer); this.lifetime.abort(); await this.running; await this.domain.close()
  }
}
