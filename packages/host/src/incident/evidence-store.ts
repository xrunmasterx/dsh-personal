/** Personal workbench incident/evidence-store; business rules migrated from ai-workflow. */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Config } from '../config.ts'
import { removeOwnedPath, type RunBudget } from '../storage.ts'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { McpToolCallItem, ThreadItem } from '@openai/codex-sdk'
import type { Entry, ZipFile } from 'yauzl'
import * as yauzl from 'yauzl'

import {
  attachmentArtifactSchema,
  evidenceDossierSchema,
  evidenceItemSchema,
  type AttachmentArtifact,
  type AttachmentCandidate,
  type EvidenceDossier,
} from './schema.ts'

const tapdHttpUpgradeHosts = new Set(['file.tapd.woa.com'])

const textExtensions = new Set([
  '.cfg',
  '.crashcontext',
  '.csv',
  '.ini',
  '.json',
  '.log',
  '.out',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
])

interface StoredTextFile {
  relativePath: string
  absolutePath: string
  sizeBytes: number
  sha256: string
}

/**
 * Complete collected text with source identity, Case ownership and a short description.
 */
export interface CollectedTextEvidence {
  id: string
  caseId: string
  source: 'crashsight'
  kind: 'log' | 'stack' | 'metadata'
  name: string
  content: string
  summary: string
}

type EvidenceFileKind = AttachmentArtifact['textFiles'][number]['kind']

function classifyEvidenceFile(name: string, collectedKind?: CollectedTextEvidence['kind']): EvidenceFileKind {
  if (collectedKind === 'stack') {
    return /thread/i.test(name) ? 'thread_dump' : 'main_stack'
  }
  if (
    collectedKind === 'metadata' ||
    /(?:crashcontext|metadata|valuemap|customkv)|\.(?:json|xml|ini|cfg|csv|ya?ml)$/i.test(name)
  ) {
    return 'metadata'
  }
  if (collectedKind === 'log') {
    return 'runtime_log'
  }
  if (/thread/i.test(name)) {
    return 'thread_dump'
  }
  if (/(?:stack|callstack)/i.test(name)) {
    return 'main_stack'
  }
  if (/\.(?:log|out)$/i.test(name)) {
    return 'runtime_log'
  }
  if (/(?:crashcontext|metadata|valuemap|customkv|register|module)/i.test(name)) {
    return 'metadata'
  }
  return 'other_text'
}

function evidenceItemKindForFile(kind: EvidenceFileKind): 'log' | 'stack' | 'metadata' | 'other' {
  if (kind === 'runtime_log') {
    return 'log'
  }
  if (kind === 'main_stack' || kind === 'thread_dump') {
    return 'stack'
  }
  return kind === 'metadata' ? 'metadata' : 'other'
}

function isMcpToolCall(item: ThreadItem): item is McpToolCallItem {
  return item.type === 'mcp_tool_call'
}

function safeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function findStringProperty(value: unknown, keys: Set<string>): string | null {
  const normalized = safeJsonValue(value)
  if (!normalized || typeof normalized !== 'object') {
    return null
  }

  for (const [key, child] of Object.entries(normalized)) {
    if (keys.has(key.toLowerCase()) && (typeof child === 'string' || typeof child === 'number')) {
      return String(child)
    }
  }

  for (const child of Object.values(normalized)) {
    const match = findStringProperty(child, keys)
    if (match) {
      return match
    }
  }

  return null
}

function collectUrlStrings(value: unknown, result: string[]): void {
  const normalized = safeJsonValue(value)
  if (typeof normalized === 'string') {
    for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      result.push(match[0].replace(/[),.;\]}]+$/, ''))
    }
    return
  }

  if (Array.isArray(normalized)) {
    for (const child of normalized) {
      collectUrlStrings(child, result)
    }
    return
  }

  if (normalized && typeof normalized === 'object') {
    for (const child of Object.values(normalized)) {
      collectUrlStrings(child, result)
    }
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

/**
 * Reject attachment URLs that escape the permitted HTTPS download policy.
 * @param value - untrusted source URL.
 * @returns the accepted URL; invalid download locations throw.
 */
export function validateAttachmentDownloadUrl(value: string): URL {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  const ipHostname = hostname.replace(/^\[/, '').replace(/\]$/, '')

  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Attachment download URL must use HTTPS without embedded credentials.')
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Attachment download URL cannot target a local hostname.')
  }

  const ipVersion = isIP(ipHostname)
  if (
    (ipVersion === 4 && isPrivateIpv4(ipHostname)) ||
    (ipVersion === 6 && /^(::1|fc|fd|fe8|fe9|fea|feb)/i.test(ipHostname))
  ) {
    throw new Error('Attachment download URL cannot target a private or loopback address.')
  }

  return url
}

function normalizeTapdAttachmentDownloadUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'http:' && tapdHttpUpgradeHosts.has(url.hostname.toLowerCase())) {
    url.protocol = 'https:'
  }

  return validateAttachmentDownloadUrl(url.toString()).toString()
}

function collectTapdAttachmentDownloadUrls(items: ThreadItem[]): Map<string, string> {
  const urlsByAttachmentId = new Map<string, string>()
  const attachmentIdKeys = new Set(['id', 'attachmentid', 'attachment_id'])

  for (const item of items) {
    if (
      !isMcpToolCall(item) ||
      item.status !== 'completed' ||
      item.server !== 'tapd' ||
      item.tool !== 'get_attachment_download_url' ||
      !item.result
    ) {
      continue
    }

    const attachmentId = findStringProperty(item.arguments, attachmentIdKeys)
    if (!attachmentId) {
      continue
    }

    const candidates: string[] = []
    collectUrlStrings(item.result.structured_content, candidates)
    for (const block of item.result.content) {
      if (block.type === 'text') {
        collectUrlStrings(block.text, candidates)
      } else if (block.type === 'resource_link') {
        collectUrlStrings(block.uri, candidates)
      } else if (block.type === 'resource' && 'text' in block.resource) {
        collectUrlStrings(block.resource.text, candidates)
      }
    }

    let downloadUrl: string | undefined
    for (const candidate of candidates) {
      try {
        downloadUrl = normalizeTapdAttachmentDownloadUrl(candidate)
        break
      } catch {
        // Continue to another URL returned by the completed tool call.
      }
    }
    if (downloadUrl) {
      urlsByAttachmentId.set(attachmentId, downloadUrl)
    }
  }

  return urlsByAttachmentId
}

function sanitizePathComponent(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return sanitized || 'unnamed'
}

function getIncidentPackagePath(evidenceStoreRoot: string, workflowRunId: string): string {
  return join(resolve(evidenceStoreRoot), sanitizePathComponent(workflowRunId))
}

async function writeUtf8FileAtomically(targetPath: string, content: string, budget: RunBudget): Promise<void> {
  budget.charge(Buffer.byteLength(content))
  await mkdir(dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

async function writeIncidentManifest(input: {
  dossier: EvidenceDossier
  packagePath: string
  workflowRunId: string
  status: 'collecting' | 'completed' | 'no_evidence'
  reportPath?: string
  budget: RunBudget
}): Promise<void> {
  const manifestPath = join(input.packagePath, 'manifest.json')
  let createdAt = new Date().toISOString()
  try {
    const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as { createdAt?: unknown }
    if (typeof existing.createdAt === 'string') {
      createdAt = existing.createdAt
    }
  } catch {
    // A missing or incomplete manifest is replaced by the current authoritative snapshot.
  }

  await writeUtf8FileAtomically(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workflowRunId: input.workflowRunId,
        createdAt,
        updatedAt: new Date().toISOString(),
        status: input.status,
        ticket: input.dossier.ticket,
        cases: input.dossier.cases.map(incidentCase => ({
          id: incidentCase.id,
          issueId: incidentCase.issueId,
          reportId: incidentCase.reportId,
        })),
        attachments: input.dossier.attachmentArtifacts,
        report: input.reportPath
          ? {
            path: relative(input.packagePath, input.reportPath),
            format: 'markdown',
          }
          : null,
      },
      null,
      2,
    )}\n`, input.budget,
  )
}

function validateArchiveEntryName(fileName: string): string {
  if (!fileName || fileName.includes('\u0000') || fileName.includes('\\')) {
    throw new Error(`Unsafe archive entry path: ${JSON.stringify(fileName)}`)
  }

  const normalized = fileName.replace(/\/+/g, '/')
  const parts = normalized.split('/').filter(part => part.length > 0 && part !== '.')
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    parts.length === 0 ||
    parts.some(part => part === '..')
  ) {
    throw new Error(`Unsafe archive entry path: ${JSON.stringify(fileName)}`)
  }

  return parts.join('/')
}

function isLikelyTextFile(fileName: string): boolean {
  const extension = extname(fileName).toLowerCase()
  return textExtensions.has(extension) || (!extension && /(?:log|trace|stack|crash)/i.test(basename(fileName)))
}

function isSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

function openZip(zipPath: string): Promise<ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(
      zipPath,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipFile) => {
        if (error) {
          rejectZip(error)
        } else {
          resolveZip(zipFile)
        }
      },
    )
  })
}

function openZipEntry(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolveStream, rejectStream) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        rejectStream(error)
      } else {
        resolveStream(stream)
      }
    })
  })
}

function createHashingLimitTransform(limitBytes: number, budget: RunBudget) {
  const hash = createHash('sha256')
  let sizeBytes = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length
      if (sizeBytes > limitBytes) {
        callback(new Error(`File exceeds the ${limitBytes}-byte safety limit.`))
        return
      }
      try { budget.charge(chunk.length) } catch (error) {
        callback(error instanceof Error ? error : new Error('Storage budget failed', { cause: error }))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  return {
    stream,
    finish: () => ({ sizeBytes, sha256: hash.digest('hex') }),
  }
}

async function extractTextFilesFromZip(
  zipPath: string,
  extractRoot: string,
  evidenceRoot: string,
  limits: Config['evidenceLimits'],
  budget: RunBudget,
  signal?: AbortSignal,
): Promise<StoredTextFile[]> {
  await mkdir(extractRoot, { recursive: true })
  let zipFile: ZipFile
  try { zipFile = await openZip(zipPath) } catch (error) {
    await removeOwnedPath(evidenceRoot, extractRoot)
    throw error
  }
  const extractedFiles: StoredTextFile[] = []
  let entryCount = 0
  let totalExtractedBytes = 0
  const { maxArchiveEntries, maxExtractedFileBytes, maxExtractedBytes } = limits
  const lifetime = new AbortController()
  const extractionSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  let inFlight: Promise<void> = Promise.resolve()

  try { return await new Promise<StoredTextFile[]>((resolveExtraction, rejectExtraction) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      lifetime.abort(error)
      zipFile.close()
      rejectExtraction(error instanceof Error ? error : new Error('Archive extraction failed', { cause: error }))
    }

    zipFile.on('error', fail)
    zipFile.on('end', () => {
      if (!settled) {
        settled = true
        resolveExtraction(extractedFiles)
      }
    })
    zipFile.on('entry', (entry: Entry) => {
      inFlight = (async () => {
        extractionSignal.throwIfAborted()
        entryCount += 1
        if (entryCount > maxArchiveEntries) {
          throw new Error(`Archive contains more than ${maxArchiveEntries} entries.`)
        }

        const safeEntryName = validateArchiveEntryName(entry.fileName)
        const isDirectory = entry.fileName.endsWith('/')
        if (isDirectory || !isLikelyTextFile(safeEntryName)) {
          zipFile.readEntry()
          return
        }
        if (entry.isEncrypted()) {
          throw new Error(`Encrypted archive entry is not supported: ${safeEntryName}`)
        }
        if (isSymlink(entry)) {
          throw new Error(`Symlink archive entry is not allowed: ${safeEntryName}`)
        }
        if (entry.uncompressedSize > maxExtractedFileBytes) {
          throw new Error(`Archive entry exceeds the per-file safety limit: ${safeEntryName}`)
        }
        if (totalExtractedBytes + entry.uncompressedSize > maxExtractedBytes) {
          throw new Error('Archive exceeds the total extracted-size safety limit.')
        }

        const targetPath = resolve(extractRoot, ...safeEntryName.split('/'))
        const targetRelative = relative(extractRoot, targetPath)
        if (targetRelative === '..' || targetRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
          throw new Error(`Archive entry escapes extraction root: ${safeEntryName}`)
        }

        await mkdir(dirname(targetPath), { recursive: true })
        const readStream = await openZipEntry(zipFile, entry)
        const hashing = createHashingLimitTransform(maxExtractedFileBytes, budget)
        await pipeline(readStream, hashing.stream, createWriteStream(targetPath, { flags: 'wx' }), {
          signal: extractionSignal,
        })
        const { sizeBytes, sha256 } = hashing.finish()
        totalExtractedBytes += sizeBytes
        extractedFiles.push({
          relativePath: relative(evidenceRoot, targetPath),
          absolutePath: targetPath,
          sizeBytes,
          sha256,
        })
        zipFile.readEntry()
      })().catch(fail)
    })

    zipFile.readEntry()
  }) } catch (error) {
    // The archive may fail while a file pipeline is still releasing its output handle.
    await inFlight
    await removeOwnedPath(evidenceRoot, extractRoot)
    throw error
  }
}

async function downloadAttachment(
  downloadUrl: string,
  targetPath: string,
  limits: Config['evidenceLimits'],
  budget: RunBudget,
  signal?: AbortSignal,
): Promise<{ sizeBytes: number; sha256: string }> {
  const { maxDownloadBytes, downloadTimeoutMs } = limits
  let url = validateAttachmentDownloadUrl(downloadUrl)
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)])
    : AbortSignal.timeout(downloadTimeoutMs)
  let response: Response | null = null
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetch(url, { redirect: 'manual', signal: requestSignal })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      break
    }

    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirectCount === 5) {
      throw new Error('Attachment download exceeded the redirect safety limit.')
    }
    url = validateAttachmentDownloadUrl(new URL(location, url).toString())
  }

  if (!response) {
    throw new Error('Attachment download did not produce a response.')
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Attachment download failed with HTTP ${response.status}.`)
  }
  try {
    if (response.url) validateAttachmentDownloadUrl(response.url)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxDownloadBytes)
      throw new Error(`Attachment exceeds the ${maxDownloadBytes}-byte download limit.`)
    await mkdir(dirname(targetPath), { recursive: true })
  } catch (error) {
    await response.body.cancel()
    throw error
  }
  const partialPath = `${targetPath}.partial`
  const hashing = createHashingLimitTransform(maxDownloadBytes, budget)
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      hashing.stream,
      createWriteStream(partialPath, { flags: 'wx' }),
      { signal: requestSignal },
    )
    await rename(partialPath, targetPath)
    return hashing.finish()
  } catch (error) {
    await rm(partialPath, { force: true })
    throw error
  }
}

async function processAttachmentCandidate(input: {
  candidate: AttachmentCandidate
  downloadUrl: string | undefined
  runRoot: string
  evidenceSource: 'tapd' | 'crashsight'
  limits: Config['evidenceLimits']
  budget: RunBudget
  signal?: AbortSignal | undefined
}): Promise<AttachmentArtifact> {
  const { candidate, downloadUrl, runRoot, evidenceSource, signal } = input
  if (!downloadUrl) {
    return attachmentArtifactSchema.parse({
      ...candidate,
      status: 'failed',
      localPath: null,
      sha256: null,
      textFiles: [],
      error: `No approved HTTPS download URL was available in the completed ${
        evidenceSource === 'crashsight' ? 'CrashSight' : 'TAPD'
      } MCP response.`,
    })
  }

  const caseDirectory = sanitizePathComponent(candidate.caseId || 'shared')
  const attachmentDirectory = join(runRoot, 'cases', caseDirectory, sanitizePathComponent(candidate.id))
  const rawPath = join(attachmentDirectory, 'raw', sanitizePathComponent(basename(candidate.name)))
  let sha256: string | null = null

  try {
    const downloaded = await downloadAttachment(downloadUrl, rawPath, input.limits, input.budget, signal)
    sha256 = downloaded.sha256

    let storedFiles: StoredTextFile[]
    if (candidate.kind === 'log_archive') {
      storedFiles = await extractTextFilesFromZip(rawPath, join(attachmentDirectory, 'text'), runRoot, input.limits, input.budget, signal)
    } else {
      storedFiles = [
        {
          relativePath: relative(runRoot, rawPath),
          absolutePath: rawPath,
          sizeBytes: downloaded.sizeBytes,
          sha256: downloaded.sha256,
        },
      ]
    }

    const textFiles = storedFiles.map((file, index) => {
      const name = basename(file.absolutePath)
      return {
        ...file,
        evidenceId: `${candidate.evidenceRef}:log:${file.sha256.slice(0, 12)}:${index + 1}`,
        name,
        kind: classifyEvidenceFile(name),
        source: evidenceSource,
      }
    })
    return attachmentArtifactSchema.parse({
      ...candidate,
      status: candidate.kind === 'log_archive' && textFiles.length > 0 ? 'extracted' : 'downloaded',
      localPath: rawPath,
      sha256: downloaded.sha256,
      textFiles,
      error: textFiles.length === 0 ? 'The attachment contained no supported text log files.' : null,
    })
  } catch (error) {
    return attachmentArtifactSchema.parse({
      ...candidate,
      status: 'failed',
      localPath: sha256 ? rawPath : null,
      sha256,
      textFiles: [],
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function normalizePerfGearValue(rawValue: string): 'Low' | 'Medium' | 'High' | 'Epic' | 'Cinematic' {
  const numericValues = ['Low', 'Medium', 'High', 'Epic', 'Cinematic'] as const
  const indexed = /^[0-4]$/.test(rawValue) ? numericValues[Number(rawValue)] : undefined
  if (indexed) {
    return indexed
  }

  const normalized = rawValue.charAt(0).toUpperCase() + rawValue.slice(1).toLowerCase()
  return normalized as (typeof numericValues)[number]
}

function parsePerfGearLogLine(line: string): 'Low' | 'Medium' | 'High' | 'Epic' | 'Cinematic' | null {
  const match = line.match(
    /(?:PerfGearQualityLevel|r\.J3EnginePerfGearQualityLevel)[^A-Z0-9]+(Low|Medium|High|Epic|Cinematic|[0-4])\b/i,
  )
  return match?.[1] ? normalizePerfGearValue(match[1]) : null
}

async function findPerfGearInFile(file: AttachmentArtifact['textFiles'][number]) {
  const input = createReadStream(file.absolutePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0

  try {
    for await (const line of lines) {
      lineNumber += 1
      const value = parsePerfGearLogLine(line)
      if (value) {
        return {
          value,
          source: `${file.evidenceId}:${lineNumber}`,
        }
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }

  return null
}

async function enrichPerfGear(
  dossier: EvidenceDossier,
  artifacts: AttachmentArtifact[],
): Promise<EvidenceDossier['cases']> {
  const cases = []
  for (const incidentCase of dossier.cases) {
    if (incidentCase.environment.perfGearQualityLevel !== 'unknown') {
      cases.push(incidentCase)
      continue
    }

    const eligibleFiles = artifacts
      .filter(
        artifact => artifact.caseId === incidentCase.id || (artifact.caseId === null && dossier.cases.length === 1),
      )
      .flatMap(artifact => artifact.textFiles)
    let perfGear = null
    for (const file of eligibleFiles) {
      perfGear = await findPerfGearInFile(file)
      if (perfGear) {
        break
      }
    }

    cases.push(
      perfGear
        ? {
          ...incidentCase,
          environment: {
            ...incidentCase.environment,
            perfGearQualityLevel: perfGear.value,
            perfGearSource: perfGear.source,
          },
        }
        : incidentCase,
    )
  }

  return cases
}

/**
 * Materialize permitted attachments and retain explicit download or extraction gaps.
 * @param input - the frozen source records and operation settings.
 * @returns the dossier with materialized files and explicit gaps.
 */
export async function enrichDossierWithAttachments(input: {
  dossier: EvidenceDossier
  threadItems?: ThreadItem[]
  attachmentDownloadUrls?: ReadonlyMap<string, string>
  evidenceSource?: 'tapd' | 'crashsight'
  evidenceStoreRoot: string
  workflowRunId: string
  limits: Config['evidenceLimits']
  budget: RunBudget
  signal?: AbortSignal | undefined
}): Promise<EvidenceDossier> {
  const {
    dossier,
    threadItems = [],
    attachmentDownloadUrls,
    evidenceSource = 'tapd',
    evidenceStoreRoot,
    workflowRunId,
    signal,
  } = input
  const runRoot = getIncidentPackagePath(evidenceStoreRoot, workflowRunId)
  await mkdir(runRoot, { recursive: true })
  const downloadUrls = new Map([...collectTapdAttachmentDownloadUrls(threadItems), ...(attachmentDownloadUrls || [])])
  const artifacts: AttachmentArtifact[] = []
  if (dossier.attachmentCandidates.length > input.limits.maxAttachments) throw new Error('附件数量超过本次任务上限，请减少样本后重试')
  for (const candidate of dossier.attachmentCandidates) {
    signal?.throwIfAborted()
    artifacts.push(
      await processAttachmentCandidate({
        candidate,
        downloadUrl: downloadUrls.get(candidate.attachmentId),
        runRoot,
        evidenceSource,
        signal,
        limits: input.limits,
        budget: input.budget,
      }),
    )
  }

  const logEvidence = artifacts.flatMap(artifact =>
    artifact.textFiles.map(file =>
      evidenceItemSchema.parse({
        id: file.evidenceId,
        caseId: artifact.caseId,
        source: evidenceSource,
        kind: evidenceItemKindForFile(file.kind),
        status: 'available_for_analysis',
        locator: file.absolutePath,
        summary: `Complete ${file.kind} evidence from ${artifact.name}: ${file.relativePath}`,
        observedFacts: [`sizeBytes=${file.sizeBytes}`, `sha256=${file.sha256}`],
      }),
    ),
  )
  const collectionErrors = [
    ...dossier.collectionErrors,
    ...artifacts.filter(artifact => artifact.error).map(artifact => `附件 ${artifact.name}：${artifact.error}`),
  ]
  const attachmentGaps = artifacts.flatMap(artifact => artifact.error ? [{
    id: `attachment-log:${artifact.id}`,
    caseId: artifact.caseId,
    description: `日志附件 ${artifact.name} 未能提供可分析文本。`,
    reason: artifact.error,
    requestedInput: '重试附件下载，或直接提供对应的完整文本日志。',
    blocking: false,
  }] : [])
  const missingEvidence = [
    ...new Map([...dossier.missingEvidence, ...attachmentGaps].map(gap => [gap.id, gap])).values(),
  ]
  const enrichedCases = await enrichPerfGear(dossier, artifacts)
  const extractedArchiveNames = new Set(
    artifacts
      .filter(artifact => artifact.status === 'extracted')
      .map(artifact => `${artifact.caseId || 'shared'}:${artifact.name}`),
  )

  let enriched = evidenceDossierSchema.parse({
    ...dossier,
    cases: enrichedCases,
    evidenceItems: [...dossier.evidenceItems, ...logEvidence],
    missingEvidence,
    binaryArtifacts: dossier.binaryArtifacts.filter(
      artifact => !extractedArchiveNames.has(`${artifact.caseId || 'shared'}:${artifact.name}`),
    ),
    collectionErrors,
    evidenceRoot: runRoot,
    attachmentArtifacts: artifacts,
  })

  try {
    await writeIncidentManifest({
      dossier: enriched,
      packagePath: runRoot,
      workflowRunId,
      status: 'collecting',
      budget: input.budget,
    })
  } catch (error) {
    enriched = evidenceDossierSchema.parse({
      ...enriched,
      collectionErrors: [
        ...enriched.collectionErrors,
        `证据 manifest 写入失败：${error instanceof Error ? error.message : String(error)}`,
      ],
    })
  }

  return enriched
}

/**
 * Store collected source text and add file references to its owning Case.
 * @param input - the frozen source records and operation settings.
 * @returns the dossier with complete text file references.
 */
export async function enrichDossierWithCollectedTextEvidence(input: {
  dossier: EvidenceDossier
  textEvidence: CollectedTextEvidence[]
  evidenceStoreRoot: string
  workflowRunId: string
  limits: Config['evidenceLimits']
  budget: RunBudget
  signal?: AbortSignal | undefined
}): Promise<EvidenceDossier> {
  const { dossier, textEvidence, evidenceStoreRoot, workflowRunId, signal } = input
  const { maxCollectedTextFileBytes, maxCollectedTextTotalBytes } = input.limits
  const runRoot = getIncidentPackagePath(evidenceStoreRoot, workflowRunId)
  await mkdir(runRoot, { recursive: true })

  const artifacts: AttachmentArtifact[] = []
  const storedEvidence = []
  let totalSizeBytes = 0

  for (const [index, item] of textEvidence.entries()) {
    signal?.throwIfAborted()
    const sizeBytes = Buffer.byteLength(item.content, 'utf8')
    if (sizeBytes > maxCollectedTextFileBytes) {
      throw new Error(
        `CrashSight text evidence ${item.name} exceeds the ${maxCollectedTextFileBytes}-byte per-file limit.`,
      )
    }
    totalSizeBytes += sizeBytes
    if (totalSizeBytes > maxCollectedTextTotalBytes) {
      throw new Error(`CrashSight text evidence exceeds the ${maxCollectedTextTotalBytes}-byte run limit.`)
    }

    const sha256 = createHash('sha256').update(item.content, 'utf8').digest('hex')
    const caseDirectory = sanitizePathComponent(item.caseId)
    const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizePathComponent(item.name)}`
    const absolutePath = join(runRoot, 'cases', caseDirectory, 'mcp-text', fileName)
    await writeUtf8FileAtomically(absolutePath, item.content, input.budget)

    const textFile = {
      evidenceId: item.id,
      name: item.name,
      kind: classifyEvidenceFile(item.name, item.kind),
      source: item.source,
      relativePath: relative(runRoot, absolutePath),
      absolutePath,
      sizeBytes,
      sha256,
    }
    artifacts.push(
      attachmentArtifactSchema.parse({
        id: `stored:${item.id}`,
        caseId: item.caseId,
        evidenceRef: item.id,
        attachmentId: item.id,
        name: item.name,
        contentType: 'text/plain; charset=utf-8',
        kind: 'text_log',
        status: 'downloaded',
        localPath: absolutePath,
        sha256,
        textFiles: [textFile],
        error: null,
      }),
    )
    storedEvidence.push(
      evidenceItemSchema.parse({
        id: item.id,
        caseId: item.caseId,
        source: item.source,
        kind: item.kind,
        status: 'available_for_analysis',
        locator: absolutePath,
        summary: item.summary,
        observedFacts: [],
      }),
    )
  }

  const combinedArtifacts = [...dossier.attachmentArtifacts, ...artifacts]
  const enrichedCases = await enrichPerfGear(dossier, combinedArtifacts)
  const evidenceById = new Map([...dossier.evidenceItems, ...storedEvidence].map(item => [item.id, item]))
  const enriched = evidenceDossierSchema.parse({
    ...dossier,
    cases: enrichedCases,
    evidenceItems: [...evidenceById.values()],
    evidenceRoot: runRoot,
    attachmentArtifacts: combinedArtifacts,
  })

  await writeIncidentManifest({
    dossier: enriched,
    packagePath: runRoot,
    workflowRunId,
    status: 'collecting',
    budget: input.budget,
  })

  return enriched
}

/**
 * Commit the Chinese report and evidence manifest beneath the owned run directory.
 * @param input - the frozen source records and operation settings.
 * @returns the committed dossier, package directory and report path.
 */
export async function finalizeIncidentPackage(input: {
  dossier: EvidenceDossier
  evidenceStoreRoot: string
  workflowRunId: string
  markdown: string
  status: 'completed' | 'no_evidence'
  budget: RunBudget
}): Promise<{
  dossier: EvidenceDossier
  packagePath: string
  reportPath: string
}> {
  const packagePath = resolve(
    input.dossier.evidenceRoot || getIncidentPackagePath(input.evidenceStoreRoot, input.workflowRunId),
  )
  const dossier = evidenceDossierSchema.parse({
    ...input.dossier,
    evidenceRoot: packagePath,
  })
  const reportPath = join(packagePath, 'report.md')

  await writeUtf8FileAtomically(reportPath, `${input.markdown.trimEnd()}\n`, input.budget)
  await writeIncidentManifest({
    dossier,
    packagePath,
    workflowRunId: input.workflowRunId,
    status: input.status,
    reportPath,
    budget: input.budget,
  })

  return { dossier, packagePath, reportPath }
}
