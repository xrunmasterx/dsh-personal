/** Read-only work-item adapters with explicit scopes, filters and completeness. */
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Config } from './config.ts'
import { openCrashSight } from './connectors/crashsight.ts'
import type { McpEndpoint } from './connectors/mcp.ts'
import { isRecord, mcpPayload, responseData } from './connectors/mcp.ts'
import { openTapd, parseTapdTodoItems, TAPD_TODO_READS, type TapdTodoRawItems } from './connectors/tapd.ts'
import type { IncidentMcpSessionFactories } from './incident/collector.ts'
import { validateAttachmentDownloadUrl } from './incident/evidence-store.ts'
import {
  crashQuerySchema,
  type CrashIssue,
  type CrashPage,
  type CrashQuery,
  type ReportPage,
  type ReportRef,
  type CrashTrendPoint,
} from './models.ts'
import { normalizePersonalTapdTodoItems } from './tapd/normalize.ts'
import { tapdTodoSnapshotSchema, type TapdTodoSnapshot } from './tapd/schema.ts'

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
function version(value: unknown): string | null {
  return value === '#$cv#$' ? null : text(value)
}
function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : null
}
function time(value: unknown): string | null {
  const numeric = number(value)
  const date =
    numeric === null
      ? typeof value === 'string'
        ? new Date(value)
        : null
      : new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric)
  return date !== null && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function total(value: unknown): number {
  const count = number(value)
  if (count === null || !Number.isSafeInteger(count) || count < 0)
    throw new Error('The provider returned no valid total count')
  return count
}

/**
 * Preserve the list's exact hash as the Report lookup key.
 * @param hash - map key from query_crash_list, or an explicit crashHash field.
 * @param row - untrusted Report metadata.
 * @param app - configured application and platform.
 * @param issueId - the Issue selected by the user.
 * @returns a normalized Report without treating crashId as its lookup hash.
 */
export function normalizeReport(
  hash: string,
  row: Record<string, unknown>,
  app: { appId: string; platformId: number },
  issueId: string | null,
): ReportRef {
  if (!hash) throw new Error('CrashSight returned a Report without a lookup hash')
  return {
    ...app,
    issueId,
    crashHash: hash,
    crashId: text(row.crashId),
    version: version(row.productVersion) ?? version(row.version),
    uploadedAt: time(row.uploadTime ?? row.crashUploadTime ?? row.expUploadTime),
  }
}

/**
 * Normalize a complete issue page while retaining unknown statistics.
 * @param payload - decoded provider JSON.
 * @param query - the exact validated query.
 * @param connectionId - namespace preventing cross-account identity collisions.
 * @returns page rows and provider total.
 */
export function normalizeIssuePage(payload: unknown, query: CrashQuery, connectionId: string): CrashPage {
  const data = responseData(payload)
  if (!Array.isArray(data.issueList)) throw new Error('CrashSight returned no issueList')
  const items = data.issueList.map((value): CrashIssue => {
    if (!isRecord(value) || !text(value.issueId)) throw new Error('CrashSight returned an Issue without an ID')
    const issueId = value.issueId as string
    const app = { appId: query.appId, platformId: query.platformId }
    const matched = isRecord(value.lastMatchedReport) ? value.lastMatchedReport : null
    const hash = matched ? text(matched.crashHash) : null
    return {
      key: `${connectionId}:issue:${query.appId}:${query.platformId}:${issueId}`,
      ...app,
      issueId,
      title: text(value.exceptionName) ?? issueId,
      message: text(value.exceptionMessage) ?? '',
      stack: text(value.keyStack) ?? '',
      status: number(value.status),
      reports: number(value.crashNum),
      devices: number(value.imeiCount),
      latestAt: time(value.lastestUploadTime),
      versions: (Array.isArray(value.version) ? value.version : [value.version]).flatMap((item) => {
        const normalized = version(item)
        return normalized ? [normalized] : []
      }),
      assignees: Array.isArray(value.assigneeList)
        ? value.assigneeList.flatMap(row => (isRecord(row) && text(row.name) ? [row.name as string] : []))
        : [],
      latestMatchedReport: matched && hash ? normalizeReport(hash, matched, app, issueId) : null,
    }
  })
  const count = total(data.numFound)
  if (!items.length && query.offset < count)
    throw new Error('CrashSight returned an empty page before its matching total; refresh the query')
  return {
    query,
    items: [...new Map(items.map(item => [item.key, item])).values()],
    total: count,
    nextOffset: query.offset + items.length < count ? query.offset + items.length : null,
    fetchedAt: new Date().toISOString(),
  }
}

/** Host adapter; the service supplies cancellation and owns all connection lifetimes. */
export class WorkbenchBoards {
  constructor(
    private readonly config: Config,
    private readonly credentials: Pick<CredentialProvider, 'resolve'>,
  ) {}

  /**
   * Reject an application outside this workbench's configured scope.
   * @param appId - provider app identity.
   * @param platformId - provider platform identity.
   */
  assertApp(appId: string, platformId: number): void {
    if (!this.config.crashApps.some(app => app.appId === appId && app.platformId === platformId))
      throw new Error('CrashSight application is outside the configured workbench scope')
  }

  /**
   * Create only the original collector's admitted business read sessions.
   * @param signal - operation lifetime and cancellation.
   * @returns factories bound to this workbench's credentials.
   */
  sessions(signal: AbortSignal): IncidentMcpSessionFactories {
    const endpoint = async (server: 'tapd' | 'crashsight'): Promise<McpEndpoint> => {
      const envName = server === 'tapd' ? this.config.tapdTokenEnv : this.config.crashSightTokenEnv
      const token = (await this.credentials.resolve(credentialRef(envName)))?.value
      if (!token) throw new Error(`Configure the ${server} credential in the Personal environment (${envName})`)
      return {
        url: server === 'tapd' ? this.config.tapdUrl : this.config.crashSightUrl,
        headers:
          server === 'tapd'
            ? { 'X-Tapd-Access-Token': token, 'X-Keep-Links': 'true', 'X-Tools-Set': 'lookup_tapd_tool' }
            : { 'X-CSMCP-API-KEY': token },
        timeoutMs: this.config.toolTimeoutMs,
        signal,
      }
    }
    return {
      openTapd: async () => openTapd(await endpoint('tapd')),
      openCrashSight: async () => openCrashSight(await endpoint('crashsight')),
    }
  }

  /**
   * Read all three personal work-item types across the token owner's TAPD projects.
   * @param signal - refresh lifetime.
   * @returns a complete normalized snapshot; any failed source rejects the refresh.
   */
  async tapd(signal: AbortSignal): Promise<TapdTodoSnapshot> {
    const session = await this.sessions(signal).openTapd()
    try {
      const raw: TapdTodoRawItems = { stories: [], bugs: [], tasks: [] }
      for (const read of TAPD_TODO_READS)
        raw[read.kind] = parseTapdTodoItems(await session.execute(read.toolName, {}))
      const items = normalizePersonalTapdTodoItems(raw)
      const fetchedAt = new Date().toISOString()
      return tapdTodoSnapshotSchema.parse({
        workspaceIds: [...new Set(items.map(item => item.workspaceId))].sort(),
        items,
        counts: {
          stories: items.filter(item => item.kind === 'story').length,
          bugs: items.filter(item => item.kind === 'bug').length,
          tasks: items.filter(item => item.kind === 'task').length,
        },
        total: items.length,
        fetchedAt,
        cacheExpiresAt: new Date(Date.parse(fetchedAt) + this.config.cacheTtlMs).toISOString(),
      })
    } finally {
      await session.disconnect()
    }
  }

  /**
   * Query one Issue page with a fixed absolute time window.
   * @param input - complete board filters and page offset.
   * @param signal - query lifetime.
   * @returns normalized issues and the provider's matching total.
   */
  async issues(input: CrashQuery, signal: AbortSignal): Promise<CrashPage> {
    const query = crashQuerySchema.parse(input)
    this.assertApp(query.appId, query.platformId)
    const session = await this.sessions(signal).openCrashSight()
    try {
      const raw = await session.execute('advanced_issue_search', {
        ...this.filters(query),
        start: query.offset,
        limit: this.config.pageSize,
        ...(query.status !== null ? { issueStatus: [query.status] } : {}),
        ...(query.issueId ? { issueId: [query.issueId] } : {}),
        sortOrder: 'desc',
      })
      const payload = mcpPayload(raw)
      return normalizeIssuePage(await this.searchPayload(payload, signal), query, this.config.connectionId)
    } finally {
      await session.disconnect()
    }
  }

  /**
   * Read an Issue's trend with explicit date, version and platform scope.
   * @param input - frozen board query; this endpoint cannot apply a stack keyword.
   * @param issueId - selected Issue.
   * @param signal - query lifetime.
   * @returns daily report and device counts in the configured provider timezone.
   */
  async trend(input: CrashQuery, issueId: string, signal: AbortSignal): Promise<CrashTrendPoint[]> {
    const query = crashQuerySchema.parse(input)
    this.assertApp(query.appId, query.platformId)
    const format = (value: number) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: this.config.crashSightTimeZone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(value).map(part => [part.type, part.value]))
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
    }
    const session = await this.sessions(signal).openCrashSight()
    try {
      const payload = responseData(mcpPayload(await session.execute('query_issue_trend', {
        appId: query.appId, issueIds: [issueId], minDate: format(query.from), maxDate: format(query.to),
        granularityUnit: 'DAY', granularityMagnitude: 1, version: query.version || '-1',
      })))
      const rows = payload.data
      if (!Array.isArray(rows)) throw new Error('CrashSight returned no trend rows')
      const points = new Map<string, CrashTrendPoint>()
      for (const row of rows) {
        if (!isRecord(row)) throw new Error('CrashSight returned an invalid trend row')
        if (row.issueId !== issueId) continue
        const trend = row.trendList ?? row.trendData
        if (!Array.isArray(trend)) throw new Error('CrashSight returned no trend points for the requested Issue')
        for (const point of trend) {
          if (!isRecord(point) || !text(point.date)) throw new Error('CrashSight returned an invalid trend point')
          if (number(point.platformId) !== query.platformId || (text(point.appId) && text(point.appId) !== query.appId)) continue
          const date = String(point.date).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
          const previous = points.get(date)
          const reports = number(point.crashNum)
          const devices = number(point.crashUser)
          points.set(date, { date, reports: reports === null ? previous?.reports ?? null : (previous?.reports ?? 0) + reports,
            devices: previous ? null : devices })
        }
      }
      return [...points.values()].sort((a, b) => a.date.localeCompare(b.date))
    } finally { await session.disconnect() }
  }

  /**
   * Read Reports under the same version, keyword and time filters as the Issue list.
   * @param input - original board query.
   * @param issueId - selected exact Issue.
   * @param signal - query lifetime.
   * @returns precise Report hashes suitable for a preview plan.
   */
  async reports(input: CrashQuery, issueId: string, signal: AbortSignal): Promise<ReportPage> {
    const query = crashQuerySchema.parse(input)
    this.assertApp(query.appId, query.platformId)
    const session = await this.sessions(signal).openCrashSight()
    try {
      const data = responseData(
        mcpPayload(
          await session.execute('query_crash_list', {
            ...this.filters(query),
            issueId: [issueId],
            start: query.offset,
            rows: this.config.pageSize,
            desc: true,
          }),
        ),
      )
      if (!isRecord(data.crashDatas)) throw new Error('CrashSight returned no Report map')
      const items = Object.entries(data.crashDatas).map(([hash, row]) => {
        if (!isRecord(row)) throw new Error('CrashSight returned malformed Report metadata')
        return normalizeReport(hash, row, { appId: query.appId, platformId: query.platformId }, issueId)
      })
      const count = total(data.numFound)
      if (!items.length && query.offset < count)
        throw new Error('CrashSight returned an empty Report page before its matching total; refresh the query')
      return {
        query,
        issueId,
        items,
        total: count,
        nextOffset: query.offset + items.length < count ? query.offset + items.length : null,
      }
    } finally {
      await session.disconnect()
    }
  }

  private filters(query: CrashQuery): Record<string, unknown> {
    return {
      appId: query.appId,
      platformId: query.platformId,
      crashUploadTimeStart: query.from,
      crashUploadTimeEnd: query.to,
      ...(query.version ? { version: [query.version] } : {}),
      ...(query.keyword ? { crashDetailKeyword: query.keyword } : {}),
    }
  }

  private async searchPayload(payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (isRecord(payload)) payload = responseData(payload)
    if (isRecord(payload) && (Array.isArray(payload.issueList) || isRecord(payload.data))) return payload
    const url =
      typeof payload === 'string'
        ? payload.trim()
        : isRecord(payload)
          ? (text(payload.data) ?? text(payload.url) ?? text(payload.downloadUrl))
          : null
    if (!url) throw new Error('CrashSight search returned neither results nor a download URL')
    const validated = validateAttachmentDownloadUrl(url)
    const response = await fetch(validated, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.toolTimeoutMs)]),
      redirect: 'error',
    })
    if (!response.ok || !response.body) throw new Error(`CrashSight search download failed (${response.status})`)
    const chunks: Buffer[] = []
    let bytes = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > this.config.maxResultBytes)
          throw new Error('CrashSight search download exceeds the configured byte limit')
        chunks.push(Buffer.from(chunk.value))
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
}
