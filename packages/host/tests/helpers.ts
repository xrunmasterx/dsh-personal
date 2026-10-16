import { PersonalRecords } from '../src/personal-records.ts'
import { Context } from '@deepseek-ai/cordis'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Storage from '@deepseek-ai/dsh-storage'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as DomainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryPolicySchema } from '../src/history-settings.ts'
import type { Config } from '../src/config.ts'
import type { IncidentMcpSessionFactories } from '../src/incident/collector.ts'
import { planIdSchema, runIdSchema, type ReportRef, type RunRecord } from '../src/models.ts'
import { personalProfileEvidenceSnapshotSchema, personalProfileIdentity } from '../src/profile/schema.ts'
import { WorkbenchStore } from '../src/store.ts'

export const tapdUrl = 'https://tapd.woa.com/tapd_fe/12345678/bug/detail/101234567890'
export const sample: ReportRef = {
  appId: 'app',
  platformId: 10,
  issueId: 'issue',
  crashHash: 'report-a',
  crashId: 'native-a',
  version: 'v1',
  uploadedAt: null,
}

export function config(root: string): Config {
  return {
    history: { ...HistoryPolicySchema(), codexHome: join(root, 'codex'), cursorStorage: join(root, 'cursor') },
    dataRoot: root,
    sourceRoot: root,
    projectName: 'ExampleProject',
    connectionId: 'test',
    tapdWorkspaceIds: ['12345678'],
    crashApps: [{ appId: 'app', platformId: 10, name: 'ExampleProject' }],
    gitSources: [],
    tapdUrl: 'https://tapd.example.test/mcp',
    tapdTokenEnv: 'TAPD_TEST_TOKEN',
    crashSightUrl: 'https://crash.example.test/mcp',
    crashSightTokenEnv: 'CS_TEST_TOKEN',
    modelProvider: 'openai',
    investigationModel: 'fixture',
    profileModel: 'fixture',
    briefPolish: { provider: 'fixture', model: 'fixture', reasoningEffort: 'off', timeoutMs: 5000, maxOutputTokens: 12000, maxOutputBytes: 262144 },
    reasoningEffort: 'high',
    investigationNetworkAccess: false,
    runTimeoutMs: 120_000,
    toolTimeoutMs: 20_000,
    planTtlMs: 300_000,
    maxCases: 3,
    maxConcurrentRuns: 2,
    pageSize: 2,
    maxResultBytes: 1_048_576,
    processGraceMs: 500,
    cacheTtlMs: 300_000,
    queryWindowDays: 7,
    pollIntervalMs: 1000,
    idlePollIntervalMs: 30000,
    maxPreviewBytes: 65536,
    crashSightTimeZone: 'Asia/Shanghai',
    maxProfileEvidence: 500,
    storage: { maxBytes: 10_737_418_240, maxRunBytes: 1_073_741_824, minFreeBytes: 0,
      temporaryRetentionHours: 24, imageRetentionDays: 7, snapshotRetentionDays: 30, draftRetentionDays: 90, runRetentionDays: 180, sweepIntervalMs: 3_600_000 },
    evidenceLimits: { maxAttachments: 48, maxDownloadBytes: 104_857_600, maxExtractedBytes: 536_870_912,
      maxExtractedFileBytes: 134_217_728, maxArchiveEntries: 2000, maxCollectedTextFileBytes: 33_554_432,
      maxCollectedTextTotalBytes: 134_217_728, downloadTimeoutMs: 60_000 },
  }
}

export async function harness(existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), 'dsh-workbench-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
  await ctx.plugin(DomainPlugin, { backend: 'json', routes: {} })
  await ctx.plugin(Jobs, { maxConcurrentJobsPerOwner: 4 })
  const records = await PersonalRecords.open(ctx)
  const detach = ctx.jobs.attachController('personal-workbench-test')
  const store = await WorkbenchStore.open(ctx)
  return {
    ctx,
    root,
    config: config(root),
    store,
    async close(remove = existingRoot === undefined) {
      await store.close()
      await records.close()
      detach()
      await ctx.fiber.dispose()
      if (remove) await rm(root, { recursive: true, force: true })
    },
  }
}

export function runRecord(): RunRecord {
  const id = runIdSchema.parse(randomUUID())
  const planId = planIdSchema.parse(randomUUID())
  return {
    id,
    planId,
    confirmedPlanIds: [planId],
    sourceKey: 'test:issue:app:10:issue',
    sourceKeys: ['test:issue:app:10:issue'],
    target: { kind: 'crash-issue', appId: 'app', platformId: 10, issueId: 'issue' },
    title: '渲染线程崩溃',
    mode: 'single',
    samples: [sample],
    caseKeys: ['test:crash:app:10:report-a'],
    additionalContext: '',
    sourceRoot: '',
    configurationDigest: 'fixture',
    status: 'queued',
    phase: 'queued',
    completedCases: 0,
    totalCases: 1,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    finishedAt: null,
    error: null,
    artifacts: [],
    legacyRunId: null,
    legacyLimitation: null,
  }
}

export function mcpSessions(
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
  closed: string[] = [],
): IncidentMcpSessionFactories {
  const envelope = (structuredContent: unknown) => ({ content: [], structuredContent })
  return {
    openTapd: async () => ({
      disconnect: async () => {
        closed.push('tapd')
      },
      execute: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'bugs_get')
          return envelope({
            data: [
              {
                id: '101234567890',
                title: '渲染线程崩溃',
                description: 'https://crashsight.qq.com/crash-reporting/crashes/app/issue/report-id/report-a?pid=10',
              },
            ],
          })
        if (tool === 'comments_get') return envelope({ data: [] })
        throw new Error(`Unexpected TAPD read ${tool}`)
      },
    }),
    openCrashSight: async () => ({
      disconnect: async () => {
        closed.push('crash')
      },
      execute: async (tool, args) => {
        calls.push({ tool, args })
        if (tool === 'get_report_detail')
          return envelope({
            code: 200,
            ret: {
              exists: true,
              crashMap: {
                appId: 'app',
                platformId: '10',
                crashHash: args.crashHash,
                crashId: `native-${String(args.crashHash)}`,
                issueId: 'issue',
                productVersion: 'v1',
                expName: 'EXCEPTION_ACCESS_VIOLATION',
                retraceCrashDetail: `Renderer!${String(args.crashHash)} (D:\\Build\\EngineSource\\Engine\\Source\\Render.cpp:10)`,
              },
            },
          })
        if (tool === 'get_report_attachments') return envelope({ data: { crashIdAndAttachmentsList: [] } })
        throw new Error(`Unexpected CrashSight read ${tool}`)
      },
    }),
  }
}

export function evidenceSnapshot() {
  return personalProfileEvidenceSnapshotSchema.parse({
    id: randomUUID(),
    identity: personalProfileIdentity,
    window: { recentStart: '2026-06-05T00:00:00Z', focusStart: '2026-08-04T00:00:00Z', end: '2026-09-03T00:00:00Z' },
    createdAt: '2026-09-03T00:00:00Z',
    coverage: [],
    evidence: [
      {
        id: 'git:repo:a',
        source: 'git',
        kind: 'commit',
        entityId: 'repo:a',
        occurredAt: '2026-09-01T00:00:00Z',
        collectedAt: '2026-09-03T00:00:00Z',
        title: '修复渲染问题',
        summary: '已合入主干的渲染提交',
        tags: ['渲染'],
        url: null,
      },
    ],
  })
}

export const aiDraft = {
  claims: [
    {
      dimension: 'domain' as const,
      topic: '渲染',
      statement: '近期参与渲染开发',
      assessment: 'core_strength' as const,
      confidence: 'high' as const,
      evidenceRefs: ['git:repo:a'],
    },
    {
      dimension: 'growth' as const,
      topic: '调试',
      statement: '补充调试资料',
      assessment: 'growth_area' as const,
      confidence: 'medium' as const,
      evidenceRefs: ['git:repo:a'],
    },
  ],
  currentFocus: [],
}
