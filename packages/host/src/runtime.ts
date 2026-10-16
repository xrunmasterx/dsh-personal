/** Durable investigations and reviewed profiles owned by one Personal Host. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ArtifactStore } from './artifacts.ts'
import { WorkbenchBoards } from './boards.ts'
import type { Config } from './config.ts'
import { redactDiagnostic } from './diagnostics.ts'
import { createModelExecutor, type ModelExecutor } from './executor.ts'
import { readGitActivity } from './git/reader.ts'
import { createMcpIncidentEvidenceCollector, parseTapdReference } from './incident/collector.ts'
import { investigate, reportReference, type PreparedInvestigation } from './incident/pipeline.ts'
import { investigationReportContentSchema, type InvestigationReportContent } from './incident/schema.ts'
import {
  planIdSchema,
  planRequestSchema,
  profileIdSchema,
  runIdSchema,
  type InvestigationPlan,
  type PlanId,
  type PlanRequest,
  type ProfileId,
  type ProfilePublication,
  type ProfileRecord,
  type ProfileState,
  type PublishRequest,
  type ReviewRequest,
  type RunId,
  type RunRecord,
  type RunStatus,
  type TapdCache,
  type WorkbenchInfo,
  type CrashDetails,
  type CrashQuery,
  type ReportRef,
  type EvidencePreview,
} from './models.ts'
import { buildPersonalProfileCodexPrompt } from './profile/codex.ts'
import { collectPersonalProfileEvidence, type PersonalProfileInvestigationSource } from './profile/evidence.ts'
import { evidenceDigest, factKey, factVersion } from './profile/facts.ts'
import { projectLegacyInvestigation } from './profile/legacy.ts'
import { captureSources, sourcesChanged } from './source-snapshot.ts'
import { buildPersonalProfileContent } from './profile/rules.ts'
import {
  personalProfileAiDraftSchema,
  personalProfileWorkflowInputSchema,
  type PersonalProfileEvidenceSnapshot,
} from './profile/schema.ts'
import { WorkbenchStore } from './store.ts'
import {
  RunBudget,
  WorkbenchStorage,
  storageFiles,
  type CleanupPreview,
  type CleanupResult,
  type CleanupToken,
  type StorageUsage,
} from './storage.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    personalWorkbench: 'personal-workbench'
  }
}

const activeStatuses = new Set<RunStatus>(['queued', 'running', 'stopping'])

/**
 * Remove credentials and remote URLs from a user-visible operational error.
 * @param error - adapter failure.
 * @returns bounded diagnostic without transport secrets.
 */
export function workbenchError(error: unknown): string {
  return redactDiagnostic(error instanceof Error ? error.message : 'Workbench operation failed', 2000)
}

/**
 * Produce one connection-scoped Case identity from a concrete Report.
 * @param connectionId - configured account namespace.
 * @param sample - exact Report lookup.
 * @returns collision-free application/platform/report key.
 */
export function sampleKey(connectionId: string, sample: RunRecord['samples'][number]): string {
  return `${connectionId}:crash:${sample.appId}:${sample.platformId}:${sample.crashHash}`
}

interface PreparedPlan {
  plan: InvestigationPlan
  prepared: PreparedInvestigation
  configurationDigest: string
}
interface ActiveExecution {
  controller: AbortController
  done: Promise<JobOutcome>
  jobId: JobId
}

/** Business owner; the Remote wrapper and model tools share this single instance. */
export class WorkbenchRuntime {
  /**
   * Scoped read-only source adapters owned by this runtime.
   */
  readonly boards: WorkbenchBoards
  /**
   * Run files served only through registered, verified identities.
   */
  readonly artifacts: ArtifactStore
  /** Capacity and reference-aware retention owned by this Host. */
  readonly storage: WorkbenchStorage
  private readonly execute: ModelExecutor
  private readonly lifetime = new AbortController()
  private readonly active = new Map<string, ActiveExecution>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly plans = new Map<PlanId, PreparedPlan>()
  private readonly configurationDigest: string
  private tapdRefresh: Promise<TapdCache> | undefined
  private evidenceRefresh: Promise<PersonalProfileEvidenceSnapshot> | undefined
  private closed = false
  private maintenanceTimer: ReturnType<typeof setTimeout> | undefined
  private lastSweep = 0

  constructor(
    private readonly ctx: Context,
    readonly config: Config,
    readonly store: WorkbenchStore,
    adapters?: { boards: WorkbenchBoards; execute: ModelExecutor },
  ) {
    this.boards = adapters?.boards ?? new WorkbenchBoards(config, ctx.credentials)
    this.execute = adapters?.execute ?? createModelExecutor(ctx, config)
    this.artifacts = new ArtifactStore(join(config.dataRoot, 'artifacts'), config.maxResultBytes)
    this.storage = new WorkbenchStorage(config, store)
    this.configurationDigest = createHash('sha256').update(JSON.stringify(config)).digest('hex')
  }

  /** Begin source freshness and conservative cleanup while the Host is running.
   * @param collectImages Optional journal-owned image sweep, awaited before rescheduling.
   */
  startMaintenance(collectImages?: () => Promise<number>): void {
    const tick = async () => {
      if (this.closed) return
      try {
        const cache = this.tapdSnapshot()
        const now = Date.now()
        if (collectImages && now - this.lastSweep >= this.config.storage.sweepIntervalMs)
          await this.operation(() => collectImages())
        if (
          (!cache.snapshot || Date.parse(cache.snapshot.cacheExpiresAt) <= now) &&
          (!cache.lastAttemptAt || Date.parse(cache.lastAttemptAt) + this.config.cacheTtlMs <= now)
        )
          await this.refreshTapd()
        if (now - this.lastSweep >= this.config.storage.sweepIntervalMs) {
          await this.operation(() =>
            this.store.commit(async () => {
              const preview = await this.storage.preview(false)
              if (preview.candidates.length) await this.storage.clean(preview.token, false)
            }),
          )
          this.lastSweep = now
        }
      } catch (error) {
        // Disposal may run while source refresh or cleanup is awaited.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.closed) this.ctx.logger.warn('Personal maintenance: %s', workbenchError(error))
      } finally {
        // Disposal may run while source refresh or cleanup is awaited.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.closed)
          this.maintenanceTimer = setTimeout(
            () => {
              void tick()
            },
            Math.min(this.config.cacheTtlMs, this.config.storage.sweepIntervalMs),
          )
      }
    }
    void tick()
  }

  /**
   * Measure owned data without invoking a model.
   * @returns current storage occupancy and limits.
   */
  storageUsage(): Promise<StorageUsage> {
    return this.operation(() => this.storage.usage())
  }

  /**
   * Prepare the exact cleanup set without removing records.
   * @param includeHistory - whether expired unreferenced investigations are included.
   * @returns deletion candidates and protected reference counts.
   */
  previewCleanup(includeHistory: boolean): Promise<CleanupPreview> {
    return this.operation(() => this.store.commit(() => this.storage.preview(includeHistory)))
  }

  /**
   * Clean only the still-valid set shown in a prior preview.
   * @param token - digest returned by that preview.
   * @param includeHistory - the same history policy as the preview.
   * @returns actual completed removals and measured remaining occupancy.
   */
  cleanStorage(token: CleanupToken, includeHistory: boolean): Promise<CleanupResult> {
    return this.operation(() => this.store.commit(() => this.storage.clean(token, includeHistory)))
  }

  /**
   * Run a bounded foreground operation owned by this plugin rather than the browser.
   * @param operation - source read or business mutation.
   * @returns its result; disposal awaits every admitted operation.
   */
  operation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Personal workbench is stopping'))
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.runTimeoutMs)])
    const task = operation(signal)
    this.operations.add(task)
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task),
    )
    return task
  }

  /**
   * Read deployment scope and model settings without exposing credentials.
   * @returns safe deployment facts for the four product pages.
   */
  async describe(): Promise<WorkbenchInfo> {
    const c = this.config
    const [tapd, crash] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(c.tapdTokenEnv)),
      this.ctx.credentials.describe(credentialRef(c.crashSightTokenEnv)),
    ])
    return {
      connectionId: c.connectionId,
      projectName: c.projectName,
      sourceRoot: c.sourceRoot,
      tapdConfigured: tapd.configured,
      crashSightConfigured: crash.configured,
      tapdWorkspaceIds: c.tapdWorkspaceIds,
      apps: c.crashApps,
      investigationModel: c.investigationModel,
      profileModel: c.profileModel,
      pageSize: c.pageSize,
      maxCases: c.maxCases,
      queryWindowDays: c.queryWindowDays,
      pollIntervalMs: c.pollIntervalMs,
      cacheTtlMs: c.cacheTtlMs,
      idlePollIntervalMs: c.idlePollIntervalMs,
    }
  }

  /** Restore exact legacy Report associations without changing reports or published profiles. */
  async restoreLegacyLinks(): Promise<void> {
    for (const run of this.listRuns()) {
      if (!run.legacyRunId || run.samples.length || !run.artifacts.some(file => file.id === 'legacy-result')) continue
      const raw: unknown = JSON.parse((await this.artifact(run.id, 'legacy-result')).toString('utf8'))
      const source = projectLegacyInvestigation(run, raw, this.config.connectionId)
      if (!source) continue
      const samples = source.cases.flatMap((item): ReportRef[] => {
        const parts = item.id.split(':')
        const appId = parts[2]
        const crashHash = parts[4]
        return parts[1] === 'crash' && parts.length === 5 && appId && crashHash
          ? [
            {
              appId,
              platformId: Number(parts[3]),
              crashHash,
              issueId: item.crashSightUrl
                ? (/\/crashes\/[^/]+\/([^/]+)/.exec(new URL(item.crashSightUrl).pathname)?.[1] ?? null)
                : null,
              crashId: null,
              version: null,
              uploadedAt: null,
            },
          ]
          : []
      })
      await this.store.commit(() =>
        this.store.domain.table('runs').put(run.id, {
          ...run,
          samples,
          caseKeys: source.cases.map(item => item.id),
          legacyLimitation: '旧版报告已恢复画像所需证据与 Report 关联；未记录的完整分析字段保持未知，原文保留。',
        }),
      )
    }
  }

  /**
   * Read fresh Issue details and separately reported trend failures.
   * @param query - frozen filters from the current board page.
   * @param issueId - selected Issue.
   * @returns exact local TAPD associations and scoped trend data.
   */
  issueDetails(query: CrashQuery, issueId: string): Promise<CrashDetails> {
    return this.operation(async (signal) => {
      const [page, trend] = await Promise.allSettled([
        this.boards.issues({ ...query, offset: 0, issueId }, signal),
        this.boards.trend(query, issueId, signal),
      ])
      if (page.status === 'rejected') throw page.reason
      const links = this.listRuns().flatMap(run =>
        run.target.kind === 'tapd' &&
        run.samples.some(
          sample =>
            sample.appId === query.appId && sample.platformId === query.platformId && sample.issueId === issueId,
        )
          ? [{ url: run.target.url, title: run.title, runId: run.id }]
          : [],
      )
      return {
        issue: page.value.items.find(item => item.issueId === issueId) ?? null,
        query,
        issueId,
        trend: trend.status === 'fulfilled' ? trend.value : [],
        trendError: trend.status === 'rejected' ? workbenchError(trend.reason) : null,
        trendTimeZone: this.config.crashSightTimeZone,
        trendIgnoresKeyword: Boolean(query.keyword),
        tapdLinks: [...new Map(links.map(link => [link.url, link])).values()],
        fetchedAt: new Date().toISOString(),
      }
    })
  }

  /**
   * Read the retained TAPD cache and its last refresh outcome.
   * @returns retained TAPD snapshot and last attempt facts.
   */
  tapdSnapshot(): TapdCache {
    const cache = this.store.domain.table('tapd').get('current')
    assert(cache, 'The workbench store initializes the TAPD cache')
    return cache
  }

  /**
   * Refresh all personal work items while retaining the last successful snapshot on failure.
   * @returns latest cache record; lastError distinguishes stale data from an empty result.
   */
  refreshTapd(): Promise<TapdCache> {
    if (this.tapdRefresh) return this.tapdRefresh
    const refresh = this.operation(async (signal) => {
      const lastAttemptAt = new Date().toISOString()
      try {
        const snapshot = await this.boards.tapd(signal)
        signal.throwIfAborted()
        return await this.store.commit(async () => {
          const value = { snapshot, lastAttemptAt, lastError: null }
          await this.storage.admitRecord(Buffer.byteLength(JSON.stringify(value)), this.active.size)
          await this.store.domain.table('tapd').put('current', value)
          return value
        })
      } catch (error) {
        if (signal.aborted) throw error
        return await this.store.commit(async () => {
          const value = { ...this.tapdSnapshot(), lastAttemptAt, lastError: workbenchError(error) }
          await this.store.domain.table('tapd').put('current', value)
          return value
        })
      }
    })
    this.tapdRefresh = refresh
    void refresh
      .finally(() => {
        this.tapdRefresh = undefined
      })
      .catch(() => undefined)
    return refresh
  }

  /**
   * Read shared investigation history from both entry points.
   * @returns all investigations, newest first, across both modes and origins.
   */
  listRuns(): RunRecord[] {
    return [...this.store.domain.table('runs').entries()]
      .map(([, run]) => run)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Read a durable run, independent of a process-local Job.
   * @param id - durable investigation identity.
   * @returns authoritative record.
   */
  getRun(id: RunId): RunRecord {
    const run = this.store.domain.table('runs').get(runIdSchema.parse(id))
    if (!run) throw new Error('Investigation was not found')
    return run
  }

  /**
   * Resolve source links without a model or attachment download and freeze exact Reports.
   * @param request - explicit user choices from either board.
   * @returns expiring plan used by the single Start confirmation.
   */
  createPlan(request: PlanRequest): Promise<InvestigationPlan> {
    return this.operation(async (signal) => {
      const input = planRequestSchema.parse(request)
      if (input.samples.length > this.config.maxCases) throw new Error('Too many samples selected')
      for (const sample of input.samples) this.boards.assertApp(sample.appId, sample.platformId)
      const id = planIdSchema.parse(randomUUID())
      const collector = createMcpIncidentEvidenceCollector({
        evidenceStoreRoot: this.artifacts.root,
        sessions: this.boards.sessions(signal),
        connectionId: this.config.connectionId,
        maxCases: this.config.maxCases,
        limits: this.config.evidenceLimits,
        budget: new RunBudget(this.config.storage.maxRunBytes, 0),
        crashApps: this.config.crashApps,
        tapdWorkspaceIds: this.config.tapdWorkspaceIds,
      })
      let selected = input.samples
      if (input.target.kind === 'crash-report') {
        this.boards.assertApp(input.target.report.appId, input.target.report.platformId)
        selected = [input.target.report]
      }
      if (input.target.kind === 'crash-issue') {
        const target = input.target
        this.boards.assertApp(target.appId, target.platformId)
        if (
          !selected.length ||
          selected.some(
            report =>
              report.appId !== target.appId ||
              report.platformId !== target.platformId ||
              report.issueId !== target.issueId,
          )
        )
          throw new Error('Select concrete Reports from this Issue first')
      }
      const dossier = await collector.collectEvidence({
        ...(input.target.kind === 'tapd' ? { tapdUrl: input.target.url } : {}),
        ...(selected.length ? { crashReferences: selected.map(reportReference) } : {}),
        additionalContext: input.additionalContext,
        materialize: false,
        runId: id,
        signal,
      })
      signal.throwIfAborted()
      const resolved = dossier.cases.map((item) => {
        if (!item.appId || !item.platformId || !item.reportId)
          throw new Error('A resolved CrashSight Case has no exact application/platform/Report')
        return {
          appId: item.appId,
          platformId: Number(item.platformId),
          issueId: item.issueId,
          crashHash: item.reportId,
          crashId: null,
          version: item.sourceVersion.buildVersion,
          uploadedAt: null,
        }
      })
      const byKey = new Map(resolved.map(sample => [sampleKey(this.config.connectionId, sample), sample]))
      const samples = selected.length
        ? selected.map((sample) => {
          const resolvedSample = byKey.get(sampleKey(this.config.connectionId, sample))
          if (!resolvedSample) throw new Error('A selected Report could not be resolved from the source')
          if (sample.version && resolvedSample.version && sample.version !== resolvedSample.version)
            throw new Error('The Report version differs from the selected sample')
          return { ...sample, version: resolvedSample.version ?? sample.version }
        })
        : resolved
      if (input.target.kind !== 'tapd' && !samples.length) throw new Error('No concrete CrashSight Report is available')
      const now = Date.now()
      for (const [key, value] of this.plans) if (Date.parse(value.plan.expiresAt) <= now) this.plans.delete(key)
      const plan: InvestigationPlan = {
        id,
        target: input.target,
        mode: input.mode,
        samples,
        title: dossier.ticket?.title || dossier.cases[0]?.exceptionName || 'CrashSight 事故调查',
        sourceRoot: this.config.sourceRoot,
        additionalContext: input.additionalContext,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.config.planTtlMs).toISOString(),
        notes: [
          ...dossier.collectionNotes,
          ...dossier.collectionErrors,
          ...dossier.missingEvidence.map(gap => gap.description),
          `Codex: ${this.config.investigationModel} / ${this.config.reasoningEffort}`,
        ],
      }
      this.plans.set(id, {
        plan,
        prepared: {
          ticket: dossier.ticket,
          ticketEvidence: dossier.evidenceItems.filter(item => item.source === 'tapd'),
        },
        configurationDigest: this.configurationDigest,
      })
      return plan
    })
  }

  /**
   * Admit an approved plan exactly once, sharing active Report work across origins.
   * @param planId - token returned by the displayed plan.
   * @returns durable run; repeated delivery returns its original identity.
   */
  startInvestigation(planId: PlanId): Promise<RunRecord> {
    return this.operation(async signal =>
      this.store.commit(async () => {
        const token = planIdSchema.parse(planId)
        const runs = this.listRuns()
        const admitted = runs.find(run => run.confirmedPlanIds.includes(token))
        if (admitted) return admitted
        const preparedPlan = this.plans.get(token)
        if (!preparedPlan || Date.parse(preparedPlan.plan.expiresAt) <= Date.now())
          throw new Error('The preview expired; prepare the investigation again')
        const { plan, prepared, configurationDigest } = preparedPlan
        if (configurationDigest !== this.configurationDigest)
          throw new Error('Workbench configuration changed; prepare a new preview')
        let sourceKey: string
        if (plan.target.kind === 'tapd') {
          const tapd = parseTapdReference(plan.target.url)
          sourceKey = `${this.config.connectionId}:tapd:${tapd.workspaceId}:${tapd.objectType}:${tapd.workItemId}`
        } else if (plan.target.kind === 'crash-issue') {
          sourceKey = `${this.config.connectionId}:issue:${plan.target.appId}:${plan.target.platformId}:${plan.target.issueId}`
        } else {
          sourceKey = sampleKey(this.config.connectionId, plan.target.report)
        }
        const caseKeys = plan.samples.length
          ? plan.samples.map(sample => sampleKey(this.config.connectionId, sample))
          : [sourceKey]
        const existing = runs.find(
          run =>
            activeStatuses.has(run.status) &&
            (run.sourceKeys.includes(sourceKey) || run.caseKeys.some(key => caseKeys.includes(key))),
        )
        if (existing) {
          if (
            existing.mode !== plan.mode ||
            existing.additionalContext !== plan.additionalContext ||
            existing.sourceRoot !== plan.sourceRoot ||
            existing.configurationDigest !== configurationDigest ||
            existing.caseKeys.length !== caseKeys.length ||
            !existing.caseKeys.every(key => caseKeys.includes(key))
          ) {
            throw new Error(
              `同一来源已有调查在执行（${existing.id}），与当前确认的模式、样本或背景不同。请查看已有调查或等待结束后重试。`,
            )
          }
          const linked = {
            ...existing,
            confirmedPlanIds: [...existing.confirmedPlanIds, token],
            sourceKeys: [...new Set([...existing.sourceKeys, sourceKey])],
            updatedAt: new Date().toISOString(),
          }
          await this.store.domain.table('runs').put(existing.id, linked)
          this.plans.delete(token)
          return linked
        }
        this.assertCapacity()
        await this.storage.admit(this.active.size)
        signal.throwIfAborted()
        const source = await stat(plan.sourceRoot)
        if (!source.isDirectory()) throw new Error('Configured source root is not a directory')
        const now = new Date().toISOString()
        const run: RunRecord = {
          id: runIdSchema.parse(randomUUID()),
          planId: token,
          confirmedPlanIds: [token],
          sourceKey,
          sourceKeys: [sourceKey],
          target: plan.target,
          title: plan.title,
          mode: plan.mode,
          samples: plan.samples,
          caseKeys,
          additionalContext: plan.additionalContext,
          sourceRoot: plan.sourceRoot,
          configurationDigest,
          status: 'queued',
          phase: 'queued',
          completedCases: 0,
          totalCases: caseKeys.length,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
          error: null,
          artifacts: [],
          legacyRunId: null,
          legacyLimitation: null,
        }
        await this.artifacts.json(run.id, 'input.json', { plan, prepared, configurationDigest })
        await this.store.domain.table('runs').put(run.id, run)
        try {
          this.launch(run.id, run.title, signal => this.executeInvestigation(run, prepared, signal))
        } catch (error) {
          await this.store.domain
            .table('runs')
            .put(run.id, { ...run, status: 'failed', error: workbenchError(error), finishedAt: now })
          throw error
        }
        this.plans.delete(token)
        return run
      }),
    )
  }

  /**
   * Request cancellation; the producer commits canceled only after cleanup.
   * @param id - investigation to stop.
   * @returns stopping or already terminal record.
   */
  cancelInvestigation(id: RunId): Promise<RunRecord> {
    return this.operation(async () =>
      this.store.commit(async () => {
        const run = this.getRun(id)
        if (!activeStatuses.has(run.status)) return run
        const execution = this.active.get(id)
        if (!execution) throw new Error('This investigation has no live execution in the current process')
        const stopping: RunRecord = { ...run, status: 'stopping', updatedAt: new Date().toISOString() }
        await this.store.domain.table('runs').put(id, stopping)
        this.ctx.jobs.kill(execution.jobId, undefined, 'Canceled in the personal workbench')
        return stopping
      }),
    )
  }

  /**
   * Read a completed, verified structured result.
   * @param id - durable run.
   * @returns structured report shared by the UI and profile evidence collector.
   */
  async result(id: RunId): Promise<InvestigationReportContent> {
    const bytes = await this.artifact(id, 'result')
    return investigationReportContentSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown)
  }

  /**
   * Preview one registered Case evidence file without accepting browser filesystem paths.
   * @param id - completed investigation.
   * @param evidenceId - identity from its structured Case result.
   * @param offset - next byte position returned by a previous preview.
   * @returns verified bounded source text.
   */
  readEvidence(id: RunId, evidenceId: string, offset: number): Promise<EvidencePreview> {
    return this.operation(async (signal) => {
      const result = await this.result(id)
      const file = result.cases
        .flatMap(bundle => bundle.caseInput.evidenceFiles)
        .find(file => file.evidenceId === evidenceId)
      if (!file) throw new Error('This evidence is not registered in the selected investigation')
      return this.artifacts.preview(id, file, offset, this.config.maxPreviewBytes, signal)
    })
  }

  /**
   * Read only an artifact registered by a completed run.
   * @param id - durable run identity.
   * @param artifactId - feature-owned artifact identity.
   * @returns verified file bytes.
   */
  async artifact(id: RunId, artifactId: string): Promise<Buffer> {
    const run = this.getRun(id)
    const artifact = run.artifacts.find(file => file.id === artifactId)
    if (!artifact) throw new Error('The requested artifact was not registered')
    return this.artifacts.read(id, artifact)
  }

  /**
   * Read current evidence, generation history and immutable publications.
   * @returns current evidence, draft revisions and immutable published versions.
   */
  profileState(): ProfileState {
    const domain = this.store.domain
    const current = domain.table('control').get('current')
    assert(current, 'The workbench store initializes the control record')
    const evidence = current.evidenceId ? domain.table('evidence').get(current.evidenceId) : null
    const published = current.publishedId ? domain.table('publications').get(current.publishedId) : null
    if (evidence === undefined || published === undefined) throw new Error('A current workbench record is missing')
    return {
      evidence,
      evidenceCheckedAt: current.evidenceCheckedAt,
      drafts: [...domain.table('profiles').entries()]
        .map(([, value]) => value)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      published,
      versions: [...domain.table('publications').entries()]
        .map(([, value]) => value)
        .sort((a, b) => b.version - a.version),
    }
  }

  /**
   * Freeze the retained Git/TAPD/investigation projections without calling a model.
   * @returns immutable evidence snapshot with source coverage and limitations.
   */
  refreshEvidence(): Promise<PersonalProfileEvidenceSnapshot> {
    if (this.evidenceRefresh) return this.evidenceRefresh
    const refresh = this.operation(async (signal) => {
      const snapshot = await collectPersonalProfileEvidence(
        {
          readGitActivity: () => readGitActivity(this.ctx, this.config, signal),
          readTapdSnapshot: async () => {
            const cache = await this.refreshTapd()
            if (cache.lastError || !cache.snapshot) throw new Error(cache.lastError ?? 'TAPD has no snapshot')
            return cache.snapshot
          },
          readInvestigations: async () => {
            const sources: PersonalProfileInvestigationSource[] = []
            for (const run of this.listRuns().filter(run => run.status === 'completed')) {
              signal.throwIfAborted()
              if (!run.artifacts.some(file => file.id === 'result')) {
                if (run.artifacts.some(file => file.id === 'legacy-result')) {
                  const raw: unknown = JSON.parse((await this.artifact(run.id, 'legacy-result')).toString('utf8'))
                  const projection = projectLegacyInvestigation(run, raw, this.config.connectionId)
                  if (projection) sources.push(projection)
                }
                continue
              }
              const result = await this.result(run.id)
              if (!run.finishedAt) throw new Error('A completed investigation has no completion time')
              sources.push({
                id: run.id,
                title: run.title,
                occurredAt: run.finishedAt,
                tapdUrl: result.dossier.ticket?.url ?? null,
                incidentKind: result.incidentKind,
                cases: result.cases.map(bundle => ({
                  id: bundle.caseInput.case.id,
                  crashSightUrl: bundle.caseInput.case.crashSightUrl,
                  conclusion: `${bundle.investigation.conclusionLevel}：${bundle.investigation.oneSentenceConclusion}`,
                  rootCauseOwner: bundle.investigation.rootCauseOwner,
                  codePaths: bundle.investigation.codeLocations.map(location => `${location.scope}/${location.path}`),
                  hypothesisTitles: bundle.investigation.hypotheses.map(hypothesis => hypothesis.title),
                })),
              })
            }
            return sources
          },
        },
        { id: randomUUID(), maxEvidence: this.config.maxProfileEvidence, ...(this.config.profileIdentity ? { identity: this.config.profileIdentity } : {}) },
      )
      const partial = snapshot.evidence.filter(item => item.legacyProjection).length
      const excluded = this.listRuns().filter(
        run =>
          run.status === 'completed' &&
          run.legacyLimitation &&
          !snapshot.evidence.some(item => item.sourceRunId === run.id),
      ).length
      if (excluded || partial)
        snapshot.coverage = snapshot.coverage.map(item =>
          item.source === 'crashsight'
            ? {
              ...item,
              limitation:
                  `${item.limitation ? `${item.limitation} ` : ''}${partial} 条证据来自旧版最小投影，缺失字段保持未知；${excluded} 条旧调查未纳入（结构不足、重复 Case 或超出时间窗口）。`.slice(
                    0,
                    500,
                  ),
            }
            : item,
        )
      signal.throwIfAborted()
      return await this.store.commit(async () => {
        const previous = this.profileState().evidence
        const selected = previous && evidenceDigest(previous) === evidenceDigest(snapshot) ? previous : snapshot
        if (selected === snapshot) {
          await this.storage.admitRecord(Buffer.byteLength(JSON.stringify(snapshot)), this.active.size)
          await this.store.domain.table('evidence').put(snapshot.id, snapshot)
        }
        await this.store.domain.table('control').update('current', current => ({
          ...current,
          evidenceId: selected.id,
          evidenceCheckedAt: new Date().toISOString(),
        }))
        return selected
      })
    })
    this.evidenceRefresh = refresh
    void refresh
      .finally(() => {
        this.evidenceRefresh = undefined
      })
      .catch(() => undefined)
    return refresh
  }

  /**
   * Start a reviewed-profile draft from one explicit evidence snapshot.
   * @param snapshotId - snapshot displayed when the user starts generation.
   * @returns durable generation record.
   */
  generateProfile(snapshotId: string): Promise<ProfileRecord> {
    return this.operation(async signal =>
      this.store.commit(async () => {
        const evidence = this.store.domain.table('evidence').get(snapshotId)
        if (!evidence) throw new Error('Refresh and select profile evidence first')
        const state = this.profileState()
        const running = state.drafts.find(draft => draft.status === 'running' || draft.status === 'stopping')
        if (running) {
          if (running.snapshotId !== snapshotId) throw new Error('另一份材料的画像正在生成，请先等待或停止该任务')
          return running
        }
        if (
          state.evidence?.id !== snapshotId ||
          Date.parse(state.evidenceCheckedAt ?? evidence.createdAt) + this.config.cacheTtlMs <= Date.now()
        )
          throw new Error('材料已更新或过期，请先刷新材料并重新选择后生成草稿')
        this.assertCapacity()
        await this.storage.admit(this.active.size)
        const frozen = personalProfileWorkflowInputSchema.parse({
          evidenceSnapshot: evidence,
          previousPublished: state.published?.content ?? null,
          rejectedClaims: state.drafts.flatMap((draft) => {
            const content = draft.content
            return (
              content?.claims
                .filter(claim => claim.reviewStatus === 'rejected')
                .map(claim => ({
                  id: claim.id,
                  evidenceRefs: claim.evidenceRefs,
                  facts: content.evidence
                    .filter(item => claim.evidenceRefs.includes(item.id))
                    .map(item => ({ key: factKey(item), version: factVersion(item) })),
                })) ?? []
            )
          }),
        })
        const now = new Date().toISOString()
        const draft: ProfileRecord = {
          id: profileIdSchema.parse(randomUUID()),
          snapshotId,
          status: 'running',
          revision: 0,
          content: null,
          createdAt: now,
          updatedAt: now,
          error: null,
        }
        const directory = join(this.config.dataRoot, 'profiles', draft.id)
        await mkdir(directory, { recursive: true })
        const frozenText = `${JSON.stringify(frozen, null, 2)}\n`
        const budget = new RunBudget(this.config.storage.maxRunBytes, 0)
        budget.charge(Buffer.byteLength(frozenText))
        await writeFile(join(directory, 'evidence.json'), frozenText, { flag: 'wx' })
        signal.throwIfAborted()
        await this.store.domain.table('profiles').put(draft.id, draft)
        try {
          this.launch(draft.id, '个人 AI 画像', async (signal) => {
            try {
              const generated = personalProfileAiDraftSchema.parse(
                await this.execute({
                  prompt: buildPersonalProfileCodexPrompt(frozen),
                  schema: personalProfileAiDraftSchema,
                  directory,
                  name: 'profile',
                  profile: true,
                  budget,
                  activity: message =>
                    this.store.commit(async () => {
                      signal.throwIfAborted()
                      await this.store.domain.table('profiles').update(draft.id, current => ({
                        ...current,
                        activity: { message, at: new Date().toISOString() },
                        updatedAt: new Date().toISOString(),
                      }))
                    }),
                  signal,
                }),
              )
              signal.throwIfAborted()
              const content = buildPersonalProfileContent(frozen, generated, new Date())
              await this.store.commit(async () => {
                signal.throwIfAborted()
                await this.store.domain.table('profiles').update(draft.id, current => ({
                  ...current,
                  status: 'completed',
                  content,
                  revision: 1,
                  updatedAt: new Date().toISOString(),
                }))
              })
              return { status: 'completed', output: `个人画像草稿 ${draft.id} 等待审核` }
            } catch (error) {
              const reason: unknown = signal.reason
              const canceled = signal.aborted && !(reason instanceof Error && reason.name === 'TimeoutError')
              await this.store.commit(() =>
                this.store.domain.table('profiles').update(draft.id, current => ({
                  ...current,
                  status: canceled ? 'canceled' : 'failed',
                  updatedAt: new Date().toISOString(),
                  error: workbenchError(error),
                })),
              )
              return { status: canceled ? 'killed' : 'failed', detail: workbenchError(error) }
            }
          })
        } catch (error) {
          await this.store.domain
            .table('profiles')
            .put(draft.id, { ...draft, status: 'failed', error: workbenchError(error) })
          throw error
        }
        return draft
      }),
    )
  }

  /**
   * Stop a profile generation and retain its frozen inputs.
   * @param id - generation owned by this Host.
   * @returns stopping until its process tree has exited.
   */
  cancelProfile(id: ProfileId): Promise<ProfileRecord> {
    return this.operation(async () =>
      this.store.commit(async () => {
        const draft = this.store.domain.table('profiles').get(profileIdSchema.parse(id))
        if (!draft) throw new Error('Profile generation was not found')
        if (draft.status !== 'running' && draft.status !== 'stopping') return draft
        const execution = this.active.get(id)
        if (!execution) throw new Error('This profile has no live generation in the current process')
        const stopping: ProfileRecord = { ...draft, status: 'stopping', updatedAt: new Date().toISOString() }
        await this.store.domain.table('profiles').put(id, stopping)
        this.ctx.jobs.kill(execution.jobId, undefined, 'Profile generation canceled in the personal workbench')
        return stopping
      }),
    )
  }

  /**
   * Apply one revision-bound human review to an unpublished draft.
   * @param request - explicit claim decision and optional corrected statement.
   * @returns next draft revision.
   */
  reviewClaim(request: ReviewRequest): Promise<ProfileRecord> {
    return this.operation(async () =>
      this.store.commit(async () => {
        const draft = this.reviewableDraft(request.generationId, request.expectedRevision)
        if (!draft.content.claims.some(claim => claim.id === request.claimId))
          throw new Error('Profile claim was not found')
        if (!['confirm', 'reject'].includes(request.action) || request.correction.length > 500)
          throw new Error('Invalid claim review')
        const content = {
          ...draft.content,
          claims: draft.content.claims.map(claim =>
            claim.id === request.claimId
              ? {
                ...claim,
                reviewStatus: request.action === 'confirm' ? ('confirmed' as const) : ('rejected' as const),
                ...(request.correction.trim()
                  ? { statement: request.correction.trim(), origin: 'mixed' as const }
                  : {}),
              }
              : claim,
          ),
        }
        const updated = { ...draft, content, revision: draft.revision + 1, updatedAt: new Date().toISOString() }
        await this.storage.admitRecord(
          Math.max(0, Buffer.byteLength(JSON.stringify(updated)) - Buffer.byteLength(JSON.stringify(draft))),
          this.active.size,
        )
        await this.store.domain.table('profiles').put(draft.id, updated)
        return updated
      }),
    )
  }

  /**
   * Persist an immutable reviewed version, then atomically replace the current pointer.
   * @param request - displayed generation and revision.
   * @returns immutable publication; a retry of the same revision is idempotent.
   */
  publishProfile(request: PublishRequest): Promise<ProfilePublication> {
    return this.operation(async () =>
      this.store.commit(async () => {
        const existing = this.profileState().versions.find(version => version.generationId === request.generationId)
        if (existing) {
          const draft = this.store.domain.table('profiles').get(request.generationId)
          if (!draft) throw new Error('The published profile has no source draft')
          if (draft.revision !== request.expectedRevision) throw new Error('The draft revision changed')
          const currentPublication = this.profileState().published
          if (!currentPublication || currentPublication.version < existing.version)
            await this.store.domain
              .table('control')
              .update('current', current => ({ ...current, publishedId: existing.id }))
          return existing
        }
        const draft = this.reviewableDraft(request.generationId, request.expectedRevision)
        if (draft.content.claims.some(claim => claim.dimension !== 'growth' && claim.reviewStatus === 'pending'))
          throw new Error('Review all ordinary claims before publishing')
        const claims = draft.content.claims.filter(claim => claim.reviewStatus === 'confirmed')
        const versions = this.profileState().versions
        const publication: ProfilePublication = {
          id: profileIdSchema.parse(randomUUID()),
          generationId: draft.id,
          version: Math.max(0, ...versions.map(value => value.version)) + 1,
          publishedAt: new Date().toISOString(),
          content: {
            ...draft.content,
            claims,
            summary:
              claims
                .map(claim => claim.statement)
                .join('；')
                .slice(0, 1000) || draft.content.identity.role,
          },
        }
        await this.storage.admitRecord(Buffer.byteLength(JSON.stringify(publication)), this.active.size)
        await this.store.domain.table('publications').put(publication.id, publication)
        await this.store.domain
          .table('control')
          .update('current', current => ({ ...current, publishedId: publication.id }))
        return publication
      }),
    )
  }

  /** Abort foreground work and Jobs, await resource release, then close storage. */
  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.maintenanceTimer)
    this.lifetime.abort(new DOMException('Personal workbench unloaded', 'AbortError'))
    await Promise.allSettled([...this.operations])
    const results = await Promise.allSettled([...this.active.values()].map(execution => execution.done))
    await this.store.close()
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []))
    if (failures.length) throw new AggregateError(failures, 'Workbench cleanup failed')
  }

  private assertCapacity(): void {
    if (this.closed) throw new Error('Personal workbench is stopping')
    if (this.active.size >= this.config.maxConcurrentRuns)
      throw new Error('The configured concurrent-run limit has been reached')
  }

  private launch(id: string, title: string, run: (signal: AbortSignal) => Promise<JobOutcome>): void {
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      AbortSignal.timeout(this.config.runTimeoutMs),
    ])
    let done: Promise<JobOutcome> | undefined
    const job = this.ctx.jobs.start({
      kind: 'personal-workbench',
      label: `${title.slice(0, 120)} · ${id}`,
      run: () => {
        done = run(signal)
          .catch((error: unknown): JobOutcome => {
            this.ctx.logger.error(
              'Personal workbench execution could not commit its outcome: %s',
              workbenchError(error),
            )
            return { status: 'failed', detail: 'The workbench could not persist the execution outcome' }
          })
          .finally(() => {
            this.active.delete(id)
          })
        return {
          done,
          cancel: () => {
            controller.abort(new DOMException('Canceled by user', 'AbortError'))
          },
        }
      },
    })
    assert(done, 'Jobs.start invokes its producer before returning the job identity')
    this.active.set(id, { controller, done, jobId: job })
  }

  private async executeInvestigation(
    run: RunRecord,
    prepared: PreparedInvestigation,
    signal: AbortSignal,
  ): Promise<JobOutcome> {
    try {
      const budget = new RunBudget(
        this.config.storage.maxRunBytes,
        (await storageFiles(this.artifacts.directory(run.id))).reduce((sum, file) => sum + file.size, 0),
      )
      const start = await captureSources(this.ctx, this.config, signal)
      budget.charge(Buffer.byteLength(JSON.stringify(start, null, 2)) + 1)
      await this.artifacts.json(run.id, 'source-start.json', start)
      await this.store.commit(() =>
        this.store.domain
          .table('runs')
          .update(run.id, current => ({ ...current, provenance: { start, end: null, changed: false } })),
      )
      const report = await investigate({
        run,
        prepared,
        config: this.config,
        boards: this.boards,
        artifacts: this.artifacts,
        execute: request =>
          this.execute({
            ...request,
            activity: message =>
              this.store.commit(async () => {
                signal.throwIfAborted()
                await this.store.domain.table('runs').update(run.id, current => ({
                  ...current,
                  activity: { message, at: new Date().toISOString() },
                  updatedAt: new Date().toISOString(),
                }))
              }),
          }),
        signal,
        budget,
        progress: (phase, completedCases, totalCases) =>
          this.store.commit(async () => {
            signal.throwIfAborted()
            await this.store.domain.table('runs').update(run.id, current => ({
              ...current,
              status: 'running',
              phase,
              completedCases,
              totalCases,
              updatedAt: new Date().toISOString(),
              timeline: [...(current.timeline ?? []), { phase, completedCases, at: new Date().toISOString() }],
            }))
          }),
      })
      signal.throwIfAborted()
      const end = await captureSources(this.ctx, this.config, signal)
      const changed = sourcesChanged(start, end)
      budget.charge(Buffer.byteLength(JSON.stringify(end, null, 2)) + 1)
      await this.artifacts.json(run.id, 'source-finish.json', end)
      report.markdown += `\n\n## 执行版本\n\nDSH ${start.harnessVersion}；开始记录：${start.capturedAt}。\n\n${start.repositories
        .map(
          repo =>
            `- ${repo.name}：${repo.head ?? '版本未知'}；${repo.ref ?? '无分支'}=${repo.refSha ?? '未知'}；工作区改动 ${repo.trackedChanges} 项。${repo.error ?? ''}`,
        )
        .join(
          '\n',
        )}\n\n${changed ? '注意：调查期间观察到来源版本或工作区变化，结论需要按对应版本复核。' : start.repositories.some(repo => repo.error) || end.repositories.some(repo => repo.error) ? '部分来源版本未能读取，无法完整核对执行前后的源码状态。' : '执行前后记录的来源版本一致；源码目录仍是可变的本地工作区。'}\n`
      budget.charge(Buffer.byteLength(report.markdown))
      await writeFile(join(this.artifacts.directory(run.id), 'report.md'), report.markdown)
      budget.charge(Buffer.byteLength(JSON.stringify(report, null, 2)) + 1)
      await this.artifacts.json(run.id, 'result.json', report)
      const artifacts = await this.registerRunFiles(run.id)
      await this.store.commit(async () => {
        signal.throwIfAborted()
        const current = this.getRun(run.id)
        if (current.status === 'stopping') throw new DOMException('Canceled by user', 'AbortError')
        const now = new Date().toISOString()
        await this.store.domain.table('runs').put(run.id, {
          ...current,
          status: report.status,
          phase: 'finished',
          artifacts,
          completedCases: report.cases.length,
          totalCases: report.cases.length,
          updatedAt: now,
          finishedAt: now,
          provenance: { start, end, changed },
          timeline: [...(current.timeline ?? []), { phase: 'finished', completedCases: report.cases.length, at: now }],
        })
      })
      return { status: 'completed', output: `调查 ${run.id}：${report.status}` }
    } catch (error) {
      const reason: unknown = signal.reason
      const canceled = signal.aborted && !(reason instanceof Error && reason.name === 'TimeoutError')
      let artifacts = this.getRun(run.id).artifacts
      try {
        await this.artifacts.json(run.id, 'failure.json', {
          error: workbenchError(error),
          at: new Date().toISOString(),
        })
        artifacts = await this.registerRunFiles(run.id)
      } catch (diagnosticError) {
        this.ctx.logger.warn('Unable to save investigation diagnostics: %s', workbenchError(diagnosticError))
      }
      await this.store.commit(async () => {
        const current = this.getRun(run.id)
        if (!activeStatuses.has(current.status)) return
        const now = new Date().toISOString()
        await this.store.domain.table('runs').put(run.id, {
          ...current,
          status: canceled ? 'canceled' : 'failed',
          updatedAt: now,
          finishedAt: now,
          error: workbenchError(error),
          artifacts,
        })
      })
      return { status: canceled ? 'killed' : 'failed', detail: workbenchError(error) }
    }
  }

  private async registerRunFiles(id: RunId): Promise<RunRecord['artifacts']> {
    const root = this.artifacts.directory(id)
    const files = await storageFiles(root)
    const registered: RunRecord['artifacts'] = []
    for (const file of files) {
      const path = file.path.slice(root.length + 1).replaceAll('\\', '/')
      const known =
        /^(?:input|result|source-start|source-finish|failure)\.json$/.test(path) ||
        path === 'report.md' ||
        /^model-inputs\/case-[a-f0-9]{20}-(?:single|dual|mechanism)\.(?:(?:input|output|trace|error|schema)\.json|events\.jsonl)$/.test(
          path,
        )
      if (known && file.size <= this.config.maxResultBytes)
        registered.push(await this.artifacts.register(id, path.replace(/\.(?:md|jsonl?)$/, ''), path))
    }
    return registered
  }

  private reviewableDraft(
    id: ProfileId,
    revision: number,
  ): ProfileRecord & { content: NonNullable<ProfileRecord['content']> } {
    const draft = this.store.domain.table('profiles').get(profileIdSchema.parse(id))
    if (!draft || draft.status !== 'completed' || !draft.content) throw new Error('The profile draft is not ready')
    if (draft.revision !== revision) throw new Error('The draft changed; reload before reviewing')
    if (this.profileState().versions.some(version => version.generationId === id))
      throw new Error('A published draft is immutable')
    return { ...draft, content: draft.content }
  }
}
