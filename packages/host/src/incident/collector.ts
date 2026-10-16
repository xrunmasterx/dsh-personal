/** Personal workbench incident/collector; business rules migrated from ai-workflow. */

import { createHash } from 'node:crypto'

import {
  enrichDossierWithAttachments,
  enrichDossierWithCollectedTextEvidence,
  type CollectedTextEvidence,
} from './evidence-store.ts'
import {
  evidenceDossierSchema,
  evidenceItemSchema,
  type AttachmentCandidate,
  type EvidenceDossier,
  type IncidentCase,
} from './schema.ts'

const crashSightHosts = new Set(['crashsight.woa.com', 'crashsight.qq.com', 'crashsight.wetest.net'])
const crashAttachmentFields = ['customKv', 'userLog', 'customLog', 'threadInfo'] as const
const tapdToolByObjectType = {
  bug: 'bugs_get',
  story: 'stories_get',
  task: 'tasks_get',
} as const

type TapdObjectType = keyof typeof tapdToolByObjectType
type McpExecute = (toolName: string, args: Record<string, unknown>) => Promise<unknown>

interface ReadOnlyMcpSession {
  execute: McpExecute
  disconnect(): Promise<void>
}

/**
 * Collector owned by one preview or run; it respects pinned Report identities and cancellation.
 */
export interface IncidentEvidenceCollector {
  collectEvidence(input: {
    tapdUrl?: string
    crashReferences?: CrashSightReference[]
    ticketSnapshot?: EvidenceDossier['ticket']
    ticketEvidence?: EvidenceDossier['evidenceItems']
    materialize: boolean
    additionalContext?: string
    runId: string
    signal?: AbortSignal
  }): Promise<EvidenceDossier>
}

/**
 * Open one independently disposable read-only session for each business source.
 */
export interface IncidentMcpSessionFactories {
  openTapd(): Promise<ReadOnlyMcpSession>
  openCrashSight(): Promise<ReadOnlyMcpSession>
}

interface ParsedTapdReference {
  url: string
  workspaceId: string
  objectType: TapdObjectType
  workItemId: string
}

/**
 * Parsed Issue, Report or shared link; a lookup hash is distinct from an attachment crash ID.
 */
export interface CrashSightReference {
  kind: 'issue' | 'report' | 'shared'
  url: string
  appId: string | null
  issueId: string | null
  reportId: string | null
  platformId: string | null
  shareId: string | null
}

interface McpToolResponse {
  text: string[]
  structured: unknown[]
}

interface ParsedCrashDetail {
  data: Record<string, unknown>
  crashMap: Record<string, unknown>
}

function throwForCrashSightEnvelopeError(value: Record<string, unknown>): void {
  const statusCodes = [value.code, value.ret, value.status].filter(
    (candidate): candidate is number => typeof candidate === 'number',
  )
  const errorCode = typeof value.errorCode === 'string' ? value.errorCode.trim() : ''
  if (statusCodes.some(code => code !== 0 && code !== 200) || errorCode) {
    throw new Error(
      typeof value.message === 'string' && value.message.trim()
        ? value.message
        : `CrashSight returned status ${statusCodes.join('/') || errorCode}.`,
    )
  }
}

class IncidentEvidenceCollectionError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IncidentEvidenceCollectionError'
    this.code = code
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/(authorization|access[-_ ]?token|api[-_ ]?key|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, (value) => {
      try {
        const url = new URL(value)
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[URL REDACTED]'
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800)
}

function readMcpToolResponse(result: unknown, label: string): McpToolResponse {
  if (!isRecord(result)) {
    throw new Error(`${label} returned an unexpected result type.`)
  }

  const text = Array.isArray(result.content)
    ? result.content.flatMap((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
        return []
      }
      return [block.text]
    })
    : []

  if (result.isError === true) {
    const detail = text.find(value => value.trim())?.trim()
    throw new Error(detail ? `${label} failed: ${detail}` : `${label} failed.`)
  }
  if (!Array.isArray(result.content) && !('structuredContent' in result)) {
    throw new Error(`${label} returned no MCP content.`)
  }

  return {
    text,
    structured: 'structuredContent' in result ? [result.structuredContent] : [],
  }
}

function jsonValues(response: McpToolResponse): unknown[] {
  const values = [...response.structured]
  for (const text of response.text) {
    const parsed = parseMaybeJson(text)
    if (parsed !== text) {
      values.push(parsed)
    }
  }
  return values
}

function unwrapTapdRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null
  }
  if ('id' in value || 'title' in value || 'description' in value) {
    return value
  }

  for (const child of Object.values(value)) {
    if (isRecord(child) && ('id' in child || 'title' in child || 'description' in child)) {
      return child
    }
  }
  return value
}

function parseTapdRecords(response: McpToolResponse): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const value of jsonValues(response)) {
    const normalized = parseMaybeJson(value)
    const candidates = Array.isArray(normalized)
      ? normalized
      : isRecord(normalized) && Array.isArray(normalized.data)
        ? normalized.data
        : isRecord(normalized) && isRecord(normalized.data)
          ? [normalized.data]
          : []
    for (const candidate of candidates) {
      const record = unwrapTapdRecord(candidate)
      if (record) {
        records.push(record)
      }
    }
  }

  if (records.length > 0) {
    return records
  }
  if (response.text.some(value => /(?:没有|暂无|not found|no (?:data|comment))/i.test(value))) {
    return []
  }
  throw new Error('TAPD MCP returned an unsupported business response.')
}

function getString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const preferred of keys) {
    const entry = Object.entries(record).find(([key]) => key.toLowerCase() === preferred.toLowerCase())
    const value = entry?.[1]
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim()
      if (normalized) {
        return normalized
      }
    }
  }
  return null
}

function findStringDeep(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 4) {
    return null
  }
  const normalized = parseMaybeJson(value)
  if (!isRecord(normalized)) {
    return null
  }

  const direct = getString(normalized, keys)
  if (direct) {
    return direct
  }
  for (const child of Object.values(normalized)) {
    const match = findStringDeep(child, keys, depth + 1)
    if (match) {
      return match
    }
  }
  return null
}

function collectStrings(value: unknown, strings: string[], depth = 0): void {
  if (depth > 8) {
    return
  }
  const normalized = parseMaybeJson(value)
  if (typeof normalized === 'string') {
    strings.push(normalized)
  } else if (Array.isArray(normalized)) {
    for (const child of normalized) {
      collectStrings(child, strings, depth + 1)
    }
  } else if (isRecord(normalized)) {
    for (const child of Object.values(normalized)) {
      collectStrings(child, strings, depth + 1)
    }
  }
}

function decodeTapdText(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Accept an HTTPS TAPD detail URL and extract its workspace, object type and identity.
 * @param tapdUrl - user-supplied TAPD detail URL.
 * @returns validated workspace, object kind and work-item identity.
 */
export function parseTapdReference(tapdUrl: string): ParsedTapdReference {
  const url = new URL(tapdUrl)
  const segments = url.pathname.split('/').filter(Boolean).map(decodePathSegment)
  const objectTypeIndex = segments.findIndex(segment => Object.hasOwn(tapdToolByObjectType, segment))
  const objectType = segments[objectTypeIndex] as TapdObjectType | undefined
  const workspaceId = objectTypeIndex > 0 ? segments[objectTypeIndex - 1] : undefined
  const detailIndex = objectTypeIndex >= 0 ? segments.indexOf('detail', objectTypeIndex + 1) : -1
  const workItemId = detailIndex >= 0 ? segments[detailIndex + 1] : undefined

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'tapd.woa.com' ||
    !objectType ||
    !workspaceId || !/^\d+$/.test(workspaceId) ||
    !workItemId || !/^\d+$/.test(workItemId)
  ) {
    throw new Error('Unsupported TAPD URL. Expected /{workspace}/{bug|story|task}/detail/{id}.')
  }

  return {
    url: url.toString(),
    workspaceId,
    objectType,
    workItemId,
  }
}

/**
 * Extract supported CrashSight link identities without treating arbitrary URLs as Reports.
 * @param value - untrusted source URL.
 * @returns the supported reference, or null for an unrelated or unsupported URL.
 */
export function parseCrashSightReference(value: string): CrashSightReference | null {
  let url: URL
  try {
    url = new URL(value.replace(/&amp;/gi, '&'))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !crashSightHosts.has(url.hostname.toLowerCase())) {
    return null
  }

  url.hash = ''
  const segments = url.pathname.split('/').filter(Boolean).map(decodePathSegment)
  const sharedIndex = segments.indexOf('shared-report')
  const shareId = sharedIndex >= 0 ? segments[sharedIndex + 1] : undefined
  if (shareId) {
    return {
      kind: 'shared',
      url: url.toString(),
      appId: null,
      issueId: null,
      reportId: null,
      platformId: null,
      shareId,
    }
  }

  const crashesIndex = segments.indexOf('crashes')
  const appId = crashesIndex >= 0 ? segments[crashesIndex + 1] : undefined
  const issueId = crashesIndex >= 0 ? segments[crashesIndex + 2] : undefined
  if (!appId || !issueId) {
    return null
  }
  const reportMarker = segments.indexOf('report-id', crashesIndex + 3)
  const reportId = reportMarker >= 0 ? segments[reportMarker + 1] : undefined
  const platformId = url.searchParams.get('pid')?.trim() || null

  return {
    kind: reportId ? 'report' : 'issue',
    url: url.toString(),
    appId,
    issueId,
    reportId: reportId || null,
    platformId,
    shareId: null,
  }
}

function extractCrashSightReferences(values: string[]): CrashSightReference[] {
  const references = new Map<string, CrashSightReference>()
  const pattern = /https?:\/\/(?:crashsight\.woa\.com|crashsight\.qq\.com|crashsight\.wetest\.net)[^\s<>"'\])}]+/gi
  for (const value of values) {
    for (const match of value.replace(/&amp;/gi, '&').matchAll(pattern)) {
      const reference = parseCrashSightReference(match[0].replace(/[.,;]+$/, ''))
      if (reference) {
        const key = `${reference.kind}:${reference.appId}:${reference.platformId}:${reference.shareId || reference.reportId || reference.issueId}`
        references.set(key, reference)
      }
    }
  }
  return [...references.values()]
}

function parseCrashDetail(response: McpToolResponse): ParsedCrashDetail | null {
  for (const value of jsonValues(response)) {
    if (!isRecord(value)) {
      continue
    }
    throwForCrashSightEnvelopeError(value)
    const data = isRecord(value.data) ? value.data : isRecord(value.ret) ? value.ret : value
    if (data.exists === false) {
      return null
    }
    const crashMap = isRecord(data.crashMap) ? data.crashMap : isRecord(data.report) ? data.report : null
    if (crashMap) {
      return { data, crashMap }
    }
  }
  throw new Error('CrashSight returned no structured crashMap.')
}

function parseCrashAttachmentData(response: McpToolResponse): Record<string, unknown> {
  for (const value of jsonValues(response)) {
    if (!isRecord(value)) {
      continue
    }
    throwForCrashSightEnvelopeError(value)
    if (isRecord(value.data)) {
      return value.data
    }
    return value
  }
  throw new Error('CrashSight returned no structured attachment data.')
}

function asTextContent(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() ? value : null
  }
  if (Array.isArray(value) || isRecord(value)) {
    const text = JSON.stringify(value, null, 2)
    return text === '{}' || text === '[]' ? null : text
  }
  return null
}

function attachmentKind(name: string): CollectedTextEvidence['kind'] {
  if (/(?:thread|stack)/i.test(name)) {
    return 'stack'
  }
  if (/(?:kv|valuemap|metadata|module|register|fd|mem|info)/i.test(name)) {
    return 'metadata'
  }
  return 'log'
}

function collectAttachmentTexts(
  data: Record<string, unknown>,
  caseId: string,
  reportId: string,
  knownHashes: Set<string>,
): CollectedTextEvidence[] {
  const items: CollectedTextEvidence[] = []
  const add = (name: string, value: unknown) => {
    const content = asTextContent(value)
    if (!content) {
      return
    }
    const hash = createHash('sha256').update(content, 'utf8').digest('hex')
    if (knownHashes.has(hash)) {
      return
    }
    knownHashes.add(hash)
    const normalizedName = /\.[A-Za-z0-9]{1,8}$/.test(name) ? name : `${name}.txt`
    const kind = attachmentKind(normalizedName)
    items.push({
      id: `crashsight:${reportId}:${normalizedName}:${hash.slice(0, 12)}`,
      caseId,
      source: 'crashsight',
      kind,
      name: normalizedName,
      content,
      summary: `Complete CrashSight ${kind} text from ${normalizedName}.`,
    })
  }

  for (const [name, value] of Object.entries(data)) {
    if (name === 'attachList' && Array.isArray(value)) {
      for (const [index, attachment] of value.entries()) {
        if (isRecord(attachment)) {
          add(getString(attachment, ['fileName', 'name']) || `attachment-${index + 1}`, attachment.content)
        }
      }
      continue
    }
    add(name, value)
  }
  return items
}

function collectCrashSightSdkLogArchives(
  data: Record<string, unknown>,
  caseId: string,
  reportId: string,
): { candidates: AttachmentCandidate[]; downloadUrls: Map<string, string> } {
  const attachmentGroups = Array.isArray(data.crashIdAndAttachmentsList) ? data.crashIdAndAttachmentsList : []
  const candidates: AttachmentCandidate[] = []
  const downloadUrls = new Map<string, string>()

  for (const group of attachmentGroups) {
    if (!isRecord(group) || !Array.isArray(group.attachments)) {
      continue
    }
    for (const attachment of group.attachments) {
      if (!isRecord(attachment)) {
        continue
      }
      const name = getString(attachment, ['fileName', 'name'])
      const downloadUrl = getString(attachment, ['content', 'downloadUrl', 'download_url', 'url'])
      if (!name || !downloadUrl || !/\.zip$/i.test(name)) {
        continue
      }

      const key = createHash('sha256')
        .update(`${caseId}\u0000${reportId}\u0000${name}\u0000${candidates.length}`, 'utf8')
        .digest('hex')
        .slice(0, 16)
      const attachmentId = `crashsight-sdk-log:${reportId}:${key}`
      const evidenceRef = `crashsight:${reportId}:sdk-log:${key}`
      candidates.push({
        id: attachmentId,
        caseId,
        evidenceRef,
        attachmentId,
        name,
        contentType: getString(attachment, ['contentType', 'content_type', 'mimeType']) || 'application/zip',
        kind: 'log_archive',
      })
      downloadUrls.set(attachmentId, downloadUrl)
    }
  }

  return { candidates, downloadUrls }
}

function stackText(crashMap: Record<string, unknown>): string | null {
  const parts = ['retraceCrashDetail', 'rawStack', 'callStack', 'addCodeFrame'].flatMap((key) => {
    const value = crashMap[key]
    const content = asTextContent(value)
    return content ? [`## ${key}\n${content}`] : []
  })
  return parts.length > 0 ? parts.join('\n\n') : null
}

function normalizeBuildSourcePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()

  const engineMarker = '/engine/'
  const engineIndex = lower.lastIndexOf(engineMarker)
  if (engineIndex >= 0) {
    const relative = normalized.slice(engineIndex + 1)
    if (/^Engine\/(?:Source|Plugins)\//i.test(relative)) {
      return relative
    }
  }

  const project = /\/(Source|Plugins|Config)\//i.exec(normalized)
  return project ? normalized.slice(project.index + 1) : path
}

/**
 * Normalize build-machine source paths for matching against the configured source tree.
 * @param stack - stack text containing build-machine source paths.
 * @returns stack text with normalized source references.
 */
export function normalizeCrashStackSourcePaths(stack: string): string {
  return stack.replace(
    /(?:[A-Z]:)?[\\/](?:[^\\/\r\n()[\]]+[\\/])+[^\\/\r\n()[\]]+\.(?:cpp|c|cc|h|hpp|inl|usf|ush)/gi,
    normalizeBuildSourcePath,
  )
}

function parseActionableFrames(stack: string | null): IncidentCase['actionableFrames'] {
  if (!stack) {
    return []
  }
  const frames: IncidentCase['actionableFrames'] = []
  const seen = new Set<string>()
  for (const line of normalizeCrashStackSourcePaths(stack).split(/\r?\n/)) {
    const symbolMatch = line.match(
      /(?:(?<module>[A-Za-z0-9_.-]+)!)?(?<symbol>[~A-Za-z_$?][A-Za-z0-9_$?<>~`',*&-]*(?:::[~A-Za-z_$?][A-Za-z0-9_$?<>~`',*&-]*)+)/,
    )
    if (!symbolMatch?.groups?.symbol) {
      continue
    }
    const fileMatch = line.match(
      /(?<file>(?:[A-Z]:[\\/])?(?:Engine|Source|Plugins)[\\/][^\[\]()]+?\.(?:cpp|c|cc|h|hpp|inl|usf|ush))(?::|\()(?<line>\d+)/i,
    )
    const key = `${symbolMatch.groups.module || 'unknown'}!${symbolMatch.groups.symbol}:${fileMatch?.groups?.line || ''}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    frames.push({
      module: symbolMatch.groups.module || 'unknown',
      symbol: symbolMatch.groups.symbol,
      file: fileMatch?.groups?.file?.replaceAll('\\', '/') || null,
      line: fileMatch?.groups?.line ? Number(fileMatch.groups.line) : null,
    })
    if (frames.length === 20) {
      break
    }
  }
  return frames
}

function normalizedPerfGear(value: string | null) {
  if (!value) {
    return null
  }
  const match = value.match(/\b(Low|Medium|High|Epic|Cinematic)\b/i)
  const matched = match?.[1]
  if (!matched) {
    return null
  }
  return `${matched.charAt(0).toUpperCase()}${matched.slice(1).toLowerCase()}` as
    | 'Low'
    | 'Medium'
    | 'High'
    | 'Epic'
    | 'Cinematic'
}

interface CrashMetadataValue {
  value: string
  evidenceRef: string
}

function parseCrashMetadata(textEvidence: CollectedTextEvidence[]): Map<string, CrashMetadataValue> {
  const metadata = new Map<string, CrashMetadataValue>()
  for (const item of textEvidence) {
    if (item.kind !== 'metadata') {
      continue
    }
    for (const [lineIndex, line] of item.content.split(/\r?\n/).entries()) {
      const separator = line.indexOf('=')
      if (separator <= 0) {
        continue
      }
      const key = line.slice(0, separator).trim().replace(/^K#/i, '')
      const value = line.slice(separator + 1).trim()
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key) || !value) {
        continue
      }
      const normalizedKey = key.toLowerCase()
      if (!metadata.has(normalizedKey)) {
        metadata.set(normalizedKey, {
          value,
          evidenceRef: `${item.id}:line ${lineIndex + 1}`,
        })
      }
    }
  }
  return metadata
}

function metadataValue(metadata: Map<string, CrashMetadataValue>, keys: string[]): CrashMetadataValue | null {
  for (const key of keys) {
    const value = metadata.get(key.toLowerCase())
    if (value) {
      return value
    }
  }
  return null
}

function normalizedProjectChangelist(value: string | null): string | null {
  return value && /^\d+$/.test(value) ? value : null
}

function normalizedEngineCommit(value: string | null): string | null {
  return value && /^[a-f0-9]{7,64}$/i.test(value) ? value : null
}

function explicitProjectChangelist(crashMap: Record<string, unknown>): string | null {
  return normalizedProjectChangelist(
    findStringDeep(crashMap, ['projectChangelist', 'project_changelist', 'changelist', 'change_list', 'p4_cl']),
  )
}

function buildIncidentCase(input: {
  reference: CrashSightReference
  crashMap: Record<string, unknown>
  textEvidence: CollectedTextEvidence[]
}): IncidentCase {
  const { reference, crashMap, textEvidence } = input
  const reportId = getString(crashMap, ['crashId', 'crashHash', 'reportId']) || reference.reportId || null
  const caseId = reportId
    ? `report:${reportId}`
    : reference.issueId
      ? `issue:${reference.issueId}`
      : `shared:${reference.shareId}`
  const metadata = parseCrashMetadata(textEvidence)
  const metadataPerfGear = metadataValue(metadata, ['PerfGearQualityLevel'])
  const reportPerfGear = normalizedPerfGear(findStringDeep(crashMap, ['PerfGearQualityLevel', 'perfGearQualityLevel']))
  const perfGear = reportPerfGear || normalizedPerfGear(metadataPerfGear?.value || null)
  const metadataEngineCommit = metadataValue(metadata, ['git_commit', 'engineCommit'])
  const engineCommit =
    normalizedEngineCommit(findStringDeep(crashMap, ['engineCommit', 'engine_commit', 'engineGitCommit'])) ||
    normalizedEngineCommit(metadataEngineCommit?.value || null)
  const metadataProjectChangelist = metadataValue(metadata, ['p4_commit', 'p4_cl'])

  return {
    id: caseId,
    incidentKind: 'crash',
    crashSightUrl: reference.url,
    appId: reference.appId || findStringDeep(crashMap, ['appId']),
    platformId: reference.platformId || findStringDeep(crashMap, ['platformId', 'platform_id', 'pid']),
    issueId: reference.issueId || findStringDeep(crashMap, ['issueId']),
    reportId,
    exceptionName: findStringDeep(crashMap, ['expName', 'exceptionName']),
    exceptionMessage: findStringDeep(crashMap, ['expMessage', 'exceptionMessage']),
    exceptionAddress: findStringDeep(crashMap, ['expAddr', 'exceptionAddress']),
    crashingProcess: findStringDeep(crashMap, ['processName', 'process']),
    crashingThread: findStringDeep(crashMap, ['threadName', 'thread']),
    actionableFrames: parseActionableFrames(stackText(crashMap)),
    sourceVersion: {
      buildVersion:
        findStringDeep(crashMap, ['productVersion', 'buildVersion', 'version']) ||
        metadataValue(metadata, ['productVersion', 'buildVersion', 'version'])?.value ||
        null,
      platform:
        findStringDeep(crashMap, ['platform', 'osVer', 'osVersion']) ||
        metadataValue(metadata, ['platform', 'osVer', 'osVersion'])?.value ||
        (reference.platformId === '10' ? 'Windows' : null),
      projectStream:
        findStringDeep(crashMap, ['projectStream', 'project_stream', 'p4_stream']) ||
        metadataValue(metadata, ['p4_branch', 'projectStream', 'p4_stream'])?.value ||
        null,
      projectChangelist:
        explicitProjectChangelist(crashMap) || normalizedProjectChangelist(metadataProjectChangelist?.value || null),
      engineBranch:
        findStringDeep(crashMap, ['engineBranch', 'engine_branch']) ||
        metadataValue(metadata, ['git_branch', 'engineBranch'])?.value ||
        null,
      engineCommit,
    },
    environment: {
      commandLine:
        findStringDeep(crashMap, ['commandLine', 'command_line', 'cmdLine']) ||
        metadataValue(metadata, ['LaunchArgs', 'commandLine', 'cmdLine'])?.value ||
        null,
      rhi:
        findStringDeep(crashMap, ['rhi', 'defaultRhi', 'default_rhi']) ||
        metadataValue(metadata, ['rhi', 'defaultRhi'])?.value ||
        null,
      gpu:
        findStringDeep(crashMap, ['gpu', 'gpuName', 'GPU_NAME_0', 'display_card_names']) ||
        metadataValue(metadata, ['gpu', 'gpuName', 'GPU_NAME_0'])?.value ||
        null,
      deviceProfile:
        findStringDeep(crashMap, ['deviceProfile', 'device_profile']) ||
        metadataValue(metadata, ['deviceProfile'])?.value ||
        null,
      perfGearQualityLevel: perfGear || 'unknown',
      perfGearSource: reportPerfGear
        ? 'CrashSight report field'
        : perfGear
          ? metadataPerfGear?.evidenceRef || null
          : null,
    },
    evidenceRefs: textEvidence.map(item => item.id),
    missingEvidenceRefs: [],
  }
}

function reportFacts(crashMap: Record<string, unknown>): string[] {
  return [
    ['exception', findStringDeep(crashMap, ['expName', 'exceptionName'])],
    ['process', findStringDeep(crashMap, ['processName', 'process'])],
    ['thread', findStringDeep(crashMap, ['threadName', 'thread'])],
    ['version', findStringDeep(crashMap, ['productVersion', 'buildVersion'])],
  ].flatMap(([name, value]) => (value ? [`${name}=${truncate(value, 500)}`] : []))
}

/**
 * Bind scoped evidence collection to explicit sessions, artifact storage and Case limits.
 * @param options - explicit identity, resource limits and source adapters.
 * @returns a collector that closes its source sessions after each read.
 */
export function createMcpIncidentEvidenceCollector(options: {
  evidenceStoreRoot: string
  sessions: IncidentMcpSessionFactories
  connectionId: string
  maxCases: number
  limits: import('../config.ts').Config['evidenceLimits']
  budget: import('../storage.ts').RunBudget
  tapdWorkspaceIds: string[]
  crashApps: { appId: string; platformId: number }[]
}): IncidentEvidenceCollector {
  const sessions = options.sessions

  return {
    async collectEvidence({
      tapdUrl,
      crashReferences: frozenReferences,
      ticketSnapshot,
      ticketEvidence,
      materialize,
      additionalContext,
      runId,
      signal,
    }) {
      signal?.throwIfAborted()
      const reference = tapdUrl ? parseTapdReference(tapdUrl) : null
      if (reference && (!options.tapdWorkspaceIds.includes(reference.workspaceId) || reference.objectType !== 'bug'))
        throw new Error('Only configured TAPD defects can start an investigation')
      if (!reference && !frozenReferences?.length)
        throw new Error('An incident needs a TAPD ticket or a concrete CrashSight reference')
      let ticketContext = ticketSnapshot ?? null
      let title = ticketContext?.title ?? ''
      let descriptionSummary = ticketContext?.descriptionSummary ?? ''
      let comments: Record<string, unknown>[] = []
      const remoteStrings: string[] = []
      const tapdTools: string[] = []
      const crashSightTools: string[] = []
      const failedToolCalls: Array<{ server: string; tool: string; error: string }> = []
      const collectionErrors: string[] = []
      const missingEvidence: EvidenceDossier['missingEvidence'] = []
      const evidenceItems: EvidenceDossier['evidenceItems'] = [...(ticketEvidence ?? [])]
      const collectedText: CollectedTextEvidence[] = []
      const crashSightAttachmentCandidates: AttachmentCandidate[] = []
      const crashSightAttachmentDownloadUrls = new Map<string, string>()
      let tapdSession: ReadOnlyMcpSession | null = null
      let crashSightSession: ReadOnlyMcpSession | null = null

      const call = async (
        server: 'tapd' | 'crashsight',
        session: ReadOnlyMcpSession,
        toolName: string,
        args: Record<string, unknown>,
      ) => {
        signal?.throwIfAborted()
        try {
          const response = readMcpToolResponse(await session.execute(toolName, args), `${server}.${toolName}`)
          ;(server === 'tapd' ? tapdTools : crashSightTools).push(toolName)
          return response
        } catch (error) {
          failedToolCalls.push({ server, tool: toolName, error: compactError(error) })
          throw error
        }
      }

      try {
        if (reference && ticketSnapshot === undefined) {
          try {
            tapdSession = await sessions.openTapd()
          } catch (cause) {
            throw new IncidentEvidenceCollectionError(
              'TAPD_MCP_UNAVAILABLE',
              `TAPD MCP 连接或鉴权失败：${compactError(cause)}`,
              { cause },
            )
          }

          let ticketResponse: McpToolResponse
          try {
            ticketResponse = await call('tapd', tapdSession, tapdToolByObjectType[reference.objectType], {
              workspace_id: reference.workspaceId,
              id: reference.workItemId,
              fields: 'id,title,description,workspace_id,frequency,version_report,platform,os',
              limit: 10,
            })
          } catch (cause) {
            throw new IncidentEvidenceCollectionError(
              'TAPD_TICKET_READ_FAILED',
              `TAPD 单据读取失败：${compactError(cause)}`,
              { cause },
            )
          }
          const ticketRecords = parseTapdRecords(ticketResponse)
          const ticket = ticketRecords.find(record => getString(record, ['id']) === reference.workItemId)
          if (!ticket) {
            throw new IncidentEvidenceCollectionError(
              'TAPD_TICKET_NOT_FOUND',
              `TAPD 未返回指定的 ${reference.objectType} ${reference.workItemId}。`,
            )
          }

          try {
            const commentResponse = await call('tapd', tapdSession, 'comments_get', {
              workspace_id: reference.workspaceId,
              entry_type: reference.objectType,
              entry_id: reference.workItemId,
              page: 1,
              limit: 200,
            })
            comments = parseTapdRecords(commentResponse)
          } catch (error) {
            collectionErrors.push(`TAPD 评论读取失败：${compactError(error)}`)
          }

          title = getString(ticket, ['title', 'name']) || `TAPD ${reference.objectType} ${reference.workItemId}`
          const description = decodeTapdText(getString(ticket, ['description', 'content']) || '')
          descriptionSummary = truncate(description, 12_000)
          evidenceItems.push(
            evidenceItemSchema.parse({
              id: `tapd-${reference.objectType}:${reference.workItemId}`,
              caseId: null,
              source: 'tapd',
              kind: 'ticket',
              status: 'analyzed',
              locator: `${reference.objectType} ${reference.workItemId}`,
              summary: descriptionSummary || title,
              observedFacts: [
                `title=${truncate(title, 500)}`,
                ...['platform', 'version_report'].flatMap((key) => {
                  const value = getString(ticket, [key])
                  return value ? [`${key}=${truncate(value, 500)}`] : []
                }),
              ],
            }),
          )
          for (const [index, comment] of comments.entries()) {
            const content = decodeTapdText(
              findStringDeep(comment, ['description', 'content', 'comment', 'remark']) || '',
            )
            if (!content) {
              continue
            }
            evidenceItems.push(
              evidenceItemSchema.parse({
                id: `tapd-comment:${getString(comment, ['id']) || index + 1}`,
                caseId: null,
                source: 'tapd',
                kind: 'comment',
                status: 'analyzed',
                locator: `TAPD comment ${getString(comment, ['id']) || index + 1}`,
                summary: truncate(content, 4_000),
                observedFacts: [],
              }),
            )
          }

          collectStrings(ticket, remoteStrings)
          collectStrings(comments, remoteStrings)
          ticketContext = {
            url: reference.url,
            workspaceId: reference.workspaceId,
            workItemId: reference.workItemId,
            objectType: reference.objectType,
            title,
            descriptionSummary,
          }
        }
        const crashReferences = frozenReferences ?? extractCrashSightReferences(remoteStrings)
        if (crashReferences.length > options.maxCases) throw new Error('Incident exceeds the configured Case limit')
        const cases: IncidentCase[] = []
        let successfulCrashReads = 0
        let failedCrashReferenceReads = 0

        if (crashReferences.length > 0) {
          try {
            crashSightSession = await sessions.openCrashSight()
          } catch (cause) {
            throw new IncidentEvidenceCollectionError(
              'CRASHSIGHT_MCP_UNAVAILABLE',
              `CrashSight MCP 连接或鉴权失败：${compactError(cause)}`,
              { cause },
            )
          }
        }

        for (const foundReference of crashReferences) {
          if (!crashSightSession) throw new Error('CrashSight session must be open before reading Reports')
          const crashReference = { ...foundReference }
          if (crashReference.kind !== 'shared') {
            const matches = options.crashApps.filter(
              app =>
                app.appId === crashReference.appId &&
                (!crashReference.platformId || String(app.platformId) === crashReference.platformId),
            )
            const app = matches[0]
            if (matches.length !== 1 || !app)
              throw new Error('CrashSight reference is outside the configured application/platform scope')
            crashReference.platformId = String(app.platformId)
          }
          signal?.throwIfAborted()
          try {
            let detail: ParsedCrashDetail | null
            if (crashReference.kind === 'issue') {
              detail = parseCrashDetail(
                await call('crashsight', crashSightSession, 'fetch_last_crash_detail_in_issue', {
                  appId: crashReference.appId,
                  issueId: crashReference.issueId,
                }),
              )
            } else if (crashReference.kind === 'shared') {
              detail = parseCrashDetail(
                await call('crashsight', crashSightSession, 'fetch_crash_detail_by_share_id', {
                  shareId: crashReference.shareId,
                }),
              )
            } else if (crashReference.platformId && /^\d+$/.test(crashReference.platformId)) {
              detail = parseCrashDetail(
                await call('crashsight', crashSightSession, 'get_report_detail', {
                  appId: crashReference.appId,
                  platformId: Number(crashReference.platformId),
                  crashHash: crashReference.reportId,
                }),
              )
            } else {
              throw new Error('A Report reference needs its configured numeric platform ID')
            }

            if (!detail) {
              missingEvidence.push({
                id: `crashsight-empty:${crashReference.issueId || crashReference.shareId}`,
                caseId: null,
                description: 'CrashSight 链接没有返回可用的具体上报。',
                reason: 'CrashSight 成功响应，但该问题当前没有可读取的 crashMap。',
                requestedInput: '确认 CrashSight 链接权限、归档状态和问题下是否仍有上报。',
                blocking: false,
              })
              continue
            }

            const reportId = getString(detail.crashMap, ['crashId'])
            const actualAppId = getString(detail.crashMap, ['appId']) || crashReference.appId
            const actualPlatformId =
              getString(detail.crashMap, ['platformId', 'platform_id', 'pid']) || crashReference.platformId
            const matches = options.crashApps.filter(
              app => app.appId === actualAppId && (!actualPlatformId || String(app.platformId) === actualPlatformId),
            )
            const app = matches[0]
            if (matches.length !== 1 || !app) throw new Error('CrashSight returned a Report outside the configured scope')
            if (crashReference.appId && crashReference.appId !== actualAppId)
              throw new Error('CrashSight returned a different application')
            if (crashReference.platformId && actualPlatformId && crashReference.platformId !== actualPlatformId)
              throw new Error('CrashSight returned a different platform')
            crashReference.appId = actualAppId
            crashReference.platformId = String(app.platformId)
            const reportKey =
              crashReference.kind === 'report'
                ? crashReference.reportId
                : getString(detail.crashMap, ['crashHash', 'reportId'])
            if (!reportKey) throw new Error('CrashSight returned no exact Report lookup hash')
            const returnedHash = getString(detail.crashMap, ['crashHash'])
            if (crashReference.kind === 'report' && returnedHash && returnedHash !== crashReference.reportId)
              throw new Error('CrashSight returned a different Report')
            const caseId = `${options.connectionId}:crash:${crashReference.appId}:${crashReference.platformId}:${reportKey}`
            if (cases.some(item => item.id === caseId)) {
              successfulCrashReads += 1
              continue
            }
            const hashes = new Set<string>()
            const mainStack = stackText(detail.crashMap)
            const caseText: CollectedTextEvidence[] = []
            if (mainStack) {
              const hash = createHash('sha256').update(mainStack, 'utf8').digest('hex')
              hashes.add(hash)
              caseText.push({
                id: `${caseId}:main-stack:${hash.slice(0, 12)}`,
                caseId,
                source: 'crashsight',
                kind: 'stack',
                name: 'main-stack.txt',
                content: mainStack,
                summary: 'Complete CrashSight main stack from the concrete report.',
              })
            }

            if (materialize) {
              try {
                if (crashReference.kind !== 'shared' && !reportId)
                  throw new Error('Report has no native crashId for attachment lookup')
                const attachmentResponse =
                  crashReference.kind === 'shared'
                    ? await call('crashsight', crashSightSession, 'fetch_crash_attachment_by_share_id', {
                      shareId: crashReference.shareId,
                    })
                    : await call('crashsight', crashSightSession, 'get_report_attachments', {
                      appId: crashReference.appId,
                      crashId: reportId,
                      attachFields: [...crashAttachmentFields],
                      returnDownloadUrl: false,
                    })
                caseText.push(
                  ...collectAttachmentTexts(parseCrashAttachmentData(attachmentResponse), caseId, caseId, hashes),
                )
              } catch (error) {
                const gapId = `${caseId}:attachments`
                collectionErrors.push(`CrashSight 附件读取失败（${reportId}）：${compactError(error)}`)
                missingEvidence.push({
                  id: gapId,
                  caseId,
                  description: 'CrashSight 文本附件未能读取。',
                  reason: compactError(error),
                  requestedInput: '重试 CrashSight 附件读取，或手动提供对应日志。',
                  blocking: false,
                })
              }
            }
            if (materialize && crashReference.kind !== 'shared' && crashReference.appId) {
              try {
                if (!reportId) throw new Error('Report has no native crashId for attachment lookup')
                const sdkLogResponse = await call('crashsight', crashSightSession, 'get_report_attachments', {
                  appId: crashReference.appId,
                  crashId: reportId,
                  attachFields: ['sdkLog'],
                  returnDownloadUrl: true,
                })
                const sdkLogArchives = collectCrashSightSdkLogArchives(
                  parseCrashAttachmentData(sdkLogResponse),
                  caseId,
                  caseId,
                )
                crashSightAttachmentCandidates.push(...sdkLogArchives.candidates)
                for (const [attachmentId, downloadUrl] of sdkLogArchives.downloadUrls) {
                  crashSightAttachmentDownloadUrls.set(attachmentId, downloadUrl)
                }
                if (sdkLogArchives.candidates.length === 0) {
                  missingEvidence.push({
                    id: `${caseId}:sdk-log`,
                    caseId,
                    description: 'CrashSight did not return a downloadable SDK log archive.',
                    reason: 'The exact report has no SDK log attachment with a ZIP download URL.',
                    requestedInput:
                      'Upload the complete crash-window runtime log, or enable CustomizedLogFile.zip collection for this report.',
                    blocking: false,
                  })
                }
              } catch (error) {
                const gapId = `${caseId}:sdk-log`
                collectionErrors.push(`CrashSight SDK log read failed (${reportId}): ${compactError(error)}`)
                missingEvidence.push({
                  id: gapId,
                  caseId,
                  description: 'CrashSight SDK log archive could not be read.',
                  reason: compactError(error),
                  requestedInput:
                    'Retry the CrashSight SDK log download, or provide the complete crash-window runtime log directly.',
                  blocking: false,
                })
              }
            }

            const reportEvidenceId = `${caseId}:report`
            evidenceItems.push(
              evidenceItemSchema.parse({
                id: reportEvidenceId,
                caseId,
                source: 'crashsight',
                kind: 'report',
                status: 'analyzed',
                locator: `CrashSight report ${reportKey}`,
                summary:
                  findStringDeep(detail.crashMap, ['expName', 'exceptionName']) || `CrashSight report ${reportId}`,
                observedFacts: reportFacts(detail.crashMap),
              }),
            )
            const incidentCase = buildIncidentCase({
              reference: crashReference,
              crashMap: detail.crashMap,
              textEvidence: caseText,
            })
            incidentCase.id = caseId
            incidentCase.reportId = reportKey
            incidentCase.evidenceRefs = [reportEvidenceId, ...caseText.map(item => item.id)]
            incidentCase.missingEvidenceRefs = missingEvidence
              .filter(item => item.caseId === caseId)
              .map(item => item.id)
            if (!caseText.some(item => item.kind === 'stack')) {
              const gapId = `${caseId}:stack`
              missingEvidence.push({
                id: gapId,
                caseId,
                description: 'CrashSight 未返回可分析的主线程或其他线程堆栈文本。',
                reason: '详情与已请求附件中都没有非空 Stack。',
                requestedInput: '确认符号化状态，或提供对应 report 的 Stack/Minidump 分析结果。',
                blocking: false,
              })
              incidentCase.missingEvidenceRefs.push(gapId)
            }

            if (!cases.some(item => item.id === caseId)) {
              cases.push(incidentCase)
              collectedText.push(...caseText)
            }
            successfulCrashReads += 1
          } catch (error) {
            failedCrashReferenceReads += 1
            collectionErrors.push(`CrashSight 链接读取失败：${compactError(error)}`)
            missingEvidence.push({
              id: `crashsight-link:${createHash('sha256').update(crashReference.url).digest('hex').slice(0, 12)}`,
              caseId: null,
              description: 'CrashSight 链接未能转换为可分析的具体上报。',
              reason: compactError(error),
              requestedInput: '检查链接权限与 MCP 鉴权后重试。',
              blocking: false,
            })
          }
        }

        if (crashReferences.length > 0 && successfulCrashReads === 0 && failedCrashReferenceReads > 0) {
          throw new IncidentEvidenceCollectionError(
            'CRASHSIGHT_EVIDENCE_READ_FAILED',
            'CrashSight MCP 已连接，但所有关联链接的详情读取都失败；本次调查未生成误导性的“证据不足”报告。',
          )
        }

        const dossier = evidenceDossierSchema.parse({
          scope: options.connectionId,
          ticket: ticketContext,
          classification: {
            kind: crashReferences.length > 0 ? 'crash' : 'bug',
            confidence: cases.length > 0 ? 1 : 0.8,
            rationale:
              cases.length > 0
                ? 'CrashSight links were deterministically resolved to concrete reports.'
                : crashReferences.length > 0
                  ? 'The ticket links to CrashSight, but no concrete report was available.'
                  : 'No CrashSight link was present; the TAPD item is treated as a regular bug.',
          },
          symptoms: descriptionSummary ? [descriptionSummary] : title ? [title] : [],
          reproductionSteps: [],
          evidenceItems: [...new Map(evidenceItems.map(item => [item.id, item])).values()],
          cases,
          missingEvidence: [...new Map(missingEvidence.map(item => [item.id, item])).values()],
          binaryArtifacts: [],
          attachmentCandidates: crashSightAttachmentCandidates,
          collectionErrors,
          collectionNotes: [
            ...(reference
              ? [
                ticketSnapshot === undefined
                  ? `读取了 TAPD 主记录和 ${comments.length} 条评论。`
                  : '使用已确认的 TAPD 上下文快照。',
              ]
              : []),
            `发现 ${crashReferences.length} 个唯一 CrashSight 链接，形成 ${cases.length} 个独立 Case。`,
          ],
          provenance: {
            tapdTools: [...new Set(tapdTools)],
            crashSightTools: [...new Set(crashSightTools)],
            failedToolCalls,
          },
          humanContext: additionalContext?.trim() || null,
          evidenceRoot: null,
          attachmentArtifacts: [],
        })

        signal?.throwIfAborted()
        if (!materialize) return dossier
        const dossierWithCrashSightAttachments = await enrichDossierWithAttachments({
          dossier,
          attachmentDownloadUrls: crashSightAttachmentDownloadUrls,
          evidenceSource: 'crashsight',
          evidenceStoreRoot: options.evidenceStoreRoot,
          workflowRunId: runId,
          signal,
          limits: options.limits,
          budget: options.budget,
        })

        return await enrichDossierWithCollectedTextEvidence({
          dossier: dossierWithCrashSightAttachments,
          textEvidence: collectedText,
          evidenceStoreRoot: options.evidenceStoreRoot,
          workflowRunId: runId,
          signal,
          limits: options.limits,
          budget: options.budget,
        })
      } finally {
        const disconnected = await Promise.allSettled([crashSightSession?.disconnect(), tapdSession?.disconnect()])
        const failures = disconnected.flatMap(result =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        )
        if (failures.length) throw new AggregateError(failures, 'Incident MCP connections did not close cleanly')
      }
    },
  }
}
