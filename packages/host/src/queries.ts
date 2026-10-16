/** Bounded read projections over the authoritative workbench domain. */
import { z } from 'zod'
import assert from 'node:assert/strict'
import { parseTapdReference } from './incident/collector.ts'
import {
  profileIdSchema,
  runStatusSchema,
  targetSchema,
  type LinkedCrashItem,
  type LinkedCrashPage,
  type LinkedCrashQuery,
  type ProfileId,
  type ProfileView,
  type RunPage,
  type RunQuery,
  type WorkbenchChanges,
} from './models.ts'
import type { WorkbenchStore } from './store.ts'

const querySchema = z.object({
  offset: z.number().int().nonnegative(),
  target: targetSchema.nullable(),
  text: z.string().max(200),
  mode: z.enum(['all', 'single', 'dual']),
  status: z.union([z.literal('all'), runStatusSchema]),
})

const linkedCrashQuerySchema = z.object({
  offset: z.number().int().nonnegative(),
  text: z.string().max(200),
})

interface LinkedCrashAccumulator extends LinkedCrashItem {
  reports: Set<string>
  runIds: Set<string>
  versionSet: Set<string>
}

/**
 * Project only CrashSight Issues whose evidence came from a TAPD-origin investigation.
 * @param store - authoritative local domain.
 * @param query - text filter and page offset.
 * @param pageSize - maximum associations in one response.
 * @returns deduplicated TAPD-to-Issue associations without a CrashSight-wide query.
 */
export function queryLinkedCrashes(
  store: WorkbenchStore,
  query: LinkedCrashQuery,
  pageSize: number,
): LinkedCrashPage {
  const input = linkedCrashQuerySchema.parse(query)
  const tapd = store.domain.table('tapd').get('current')?.snapshot
  const currentItems = new Map(
    tapd?.items.map(item => [`${item.workspaceId}:${item.kind}:${item.id}`, item]) ?? [],
  )
  const associations = new Map<string, LinkedCrashAccumulator>()
  const runs = [...store.domain.table('runs').entries()]
    .map(([, value]) => value)
    .filter(run => run.target.kind === 'tapd')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))

  for (const run of runs) {
    if (run.target.kind !== 'tapd') continue
    const reference = parseTapdReference(run.target.url)
    const tapdIdentity = `${reference.workspaceId}:${reference.objectType}:${reference.workItemId}`
    const current = currentItems.get(tapdIdentity)
    const issues = new Map<string, typeof run.samples>()
    for (const sample of run.samples) {
      if (!sample.issueId) continue
      const key = `${sample.appId}:${sample.platformId}:${sample.issueId}`
      const samples = issues.get(key) ?? []
      samples.push(sample)
      issues.set(key, samples)
    }
    for (const [issueKey, samples] of issues) {
      const first = samples[0]
      assert(first?.issueId, 'An Issue group has an Issue identity')
      const key = `${tapdIdentity}:${issueKey}`
      let association = associations.get(key)
      if (!association) {
        association = {
          key,
          tapd: {
            url: run.target.url,
            id: reference.workItemId,
            title: current?.title ?? run.title,
            status: current?.status ?? null,
            priority: current?.priority ?? null,
            owner: current?.owner ?? null,
            current: Boolean(current),
          },
          crash: {
            appId: first.appId,
            platformId: first.platformId,
            issueId: first.issueId,
            reportCount: 0,
            versions: [],
          },
          runCount: 0,
          latestRun: { id: run.id, status: run.status, mode: run.mode, createdAt: run.createdAt },
          reports: new Set(),
          runIds: new Set(),
          versionSet: new Set(),
        }
        associations.set(key, association)
      }
      association.runIds.add(run.id)
      for (const sample of samples) {
        association.reports.add(`${sample.appId}:${sample.platformId}:${sample.crashHash}`)
        if (sample.version) association.versionSet.add(sample.version)
      }
    }
  }

  const all = [...associations.values()].map(({ reports, runIds, versionSet, ...association }) => ({
    ...association,
    crash: {
      ...association.crash,
      reportCount: reports.size,
      versions: [...versionSet].sort(),
    },
    runCount: runIds.size,
  }))
  const needle = input.text.trim().toLowerCase()
  const filtered = all.filter(item =>
    `${item.tapd.title} ${item.tapd.id} ${item.crash.issueId} ${item.crash.appId} ${item.crash.versions.join(' ')}`
      .toLowerCase()
      .includes(needle),
  )
  const reportKeys = new Set(all.flatMap((item) => {
    const source = associations.get(item.key)
    return source ? [...source.reports] : []
  }))
  const items = filtered.slice(input.offset, input.offset + pageSize)
  return {
    query: input,
    items,
    total: filtered.length,
    nextOffset: input.offset + items.length < filtered.length ? input.offset + items.length : null,
    summary: {
      tapdItems: new Set(all.map(item => item.tapd.url)).size,
      issues: new Set(all.map(item => `${item.crash.appId}:${item.crash.platformId}:${item.crash.issueId}`)).size,
      reports: reportKeys.size,
    },
  }
}

/**
 * Read one page, including source associations that may be older than the first history page.
 * @param store - authoritative local domain.
 * @param query - complete filters from the history page.
 * @param connectionId - configured account namespace.
 * @param pageSize - maximum rows in a response.
 * @returns filtered count and bounded compact rows.
 */
export function queryRuns(store: WorkbenchStore, query: RunQuery, connectionId: string, pageSize: number): RunPage {
  const input = querySchema.parse(query)
  const target = input.target
  let tapdKey: string | null = null
  if (target?.kind === 'tapd') {
    const reference = parseTapdReference(target.url)
    tapdKey = `${connectionId}:tapd:${reference.workspaceId}:${reference.objectType}:${reference.workItemId}`
  }
  const runs = [...store.domain.table('runs').entries()]
    .map(([, value]) => value)
    .filter(
      run =>
        (input.mode === 'all' || input.mode === run.mode) &&
        (input.status === 'all' || input.status === run.status) &&
        `${run.title} ${run.id}`.toLowerCase().includes(input.text.toLowerCase()) &&
        (!target ||
          (tapdKey
            ? run.sourceKeys.includes(tapdKey)
            : target.kind === 'crash-issue'
              ? run.samples.some(
                sample =>
                  sample.appId === target.appId &&
                    sample.platformId === target.platformId &&
                    sample.issueId === target.issueId,
              )
              : target.kind === 'crash-report' &&
                run.samples.some(
                  sample =>
                    sample.appId === target.report.appId &&
                    sample.platformId === target.report.platformId &&
                    sample.crashHash === target.report.crashHash,
                ))),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  const items = runs
    .slice(input.offset, input.offset + pageSize)
    .map(({ id, title, mode, status, phase, completedCases, totalCases, createdAt, updatedAt, legacyLimitation }) => ({
      id,
      title,
      mode,
      status,
      phase,
      completedCases,
      totalCases,
      createdAt,
      updatedAt,
      legacyLimitation,
    }))
  return {
    query: input,
    items,
    total: runs.length,
    nextOffset: input.offset + items.length < runs.length ? input.offset + items.length : null,
  }
}

/**
 * Read current materials and a bounded review page without copying every historical version.
 * @param store - authoritative domain.
 * @param draftId - selected draft, or null to open the first row.
 * @param draftOffset - generation history offset.
 * @param versionOffset - publication history offset.
 * @param pageSize - maximum rows per history.
 * @returns current publication and only one draft body.
 */
export function queryProfile(
  store: WorkbenchStore,
  draftId: ProfileId | null,
  draftOffset: number,
  versionOffset: number,
  pageSize: number,
): ProfileView {
  z.number().int().nonnegative().parse(draftOffset)
  z.number().int().nonnegative().parse(versionOffset)
  if (draftId) profileIdSchema.parse(draftId)
  const domain = store.domain
  const control = domain.table('control').get('current')
  assert(control, 'The workbench store initializes its current pointers')
  const drafts = [...domain.table('profiles').entries()]
    .map(([, value]) => value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const versions = [...domain.table('publications').entries()]
    .map(([, value]) => value)
    .sort((a, b) => b.version - a.version)
  const page = drafts.slice(draftOffset, draftOffset + pageSize)
  const selected = page.some(draft => draft.id === draftId) ? draftId : (page[0]?.id ?? null)
  const publication = versions.find(version => version.generationId === selected)
  const evidence = control.evidenceId ? domain.table('evidence').get(control.evidenceId) : null
  const published = control.publishedId ? domain.table('publications').get(control.publishedId) : null
  if (evidence === undefined || published === undefined) throw new Error('A current workbench record is missing')
  return {
    selectedDraftId: selected,
    selectedDraftPublication: publication ? { id: publication.id, version: publication.version } : null,
    evidence,
    evidenceCheckedAt: control.evidenceCheckedAt ?? null,
    published,
    drafts: page.map(draft => ({ ...draft, content: draft.id === selected ? draft.content : null })),
    versions: versions
      .slice(versionOffset, versionOffset + pageSize)
      .map(({ content: _content, ...version }) => version),
    draftTotal: drafts.length,
    versionTotal: versions.length,
    draftOffset,
    versionOffset,
    nextDraftOffset: draftOffset + pageSize < drafts.length ? draftOffset + pageSize : null,
    nextVersionOffset: versionOffset + pageSize < versions.length ? versionOffset + pageSize : null,
  }
}

/**
 * Poll only revisions and live task activity; idle histories never enter this response.
 * @param store - authoritative domain.
 * @returns small change tokens and live activity indicators.
 */
export function queryChanges(store: WorkbenchStore): WorkbenchChanges {
  return {
    revisions: store.revision(),
    activeRuns: [...store.domain.table('runs').entries()]
      .filter(([, run]) => ['queued', 'running', 'stopping'].includes(run.status))
      .map(([id, run]) => ({ id, activity: run.activity ?? null })),
    activeProfiles: [...store.domain.table('profiles').entries()]
      .filter(([, draft]) => ['running', 'stopping'].includes(draft.status))
      .map(([id, draft]) => ({ id, activity: draft.activity ?? null })),
  }
}
