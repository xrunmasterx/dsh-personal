/** Offline, WAL-aware import of selected ai-workflow business records and their original files. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ArtifactStore, inside } from './artifacts.ts'
import { parseTapdReference } from './incident/collector.ts'
import { investigationReportContentSchema, type InvestigationReportContent } from './incident/schema.ts'
import {
  planIdSchema,
  profileIdSchema,
  profileRecordSchema,
  publicationSchema,
  runIdSchema,
  runRecordSchema,
  type Artifact,
  type RunRecord,
} from './models.ts'
import { personalProfileContentSchema, personalProfileEvidenceSnapshotSchema } from './profile/schema.ts'
import type { WorkbenchStore } from './store.ts'

const workflowNames = ['incident-investigation-workflow', 'incident-multi-agent-investigation-workflow'] as const
const rowSchema = z.record(z.string(), z.unknown())
const archiveSchema = z.object({
  version: z.literal(1),
  sourceRoot: z.string(),
  connectionId: z.string(),
  createdAt: z.string(),
  investigations: z.array(rowSchema),
  workflows: z.array(rowSchema),
  snapshots: z.array(rowSchema),
  profiles: z.array(rowSchema),
  gitSources: z.array(rowSchema),
})

/** One immutable cutover, including records kept only in the lossless archive. */
export interface MigrationSummary {
  archive: string
  archivedRuns: number
  importedRuns: number
  structuredRuns: number
  reportOnlyRuns: number
  orphanRuns: string[]
  profiles: number
  publications: number
  files: number
}

function object(value: unknown): Record<string, unknown> {
  return rowSchema.parse(value)
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}
function decoded(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}
function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function uuid(key: string): string {
  const hex = digest(key)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function immutableFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (await exists(path)) {
    if (digest(await readFile(path)) !== digest(bytes))
      throw new Error(`An imported artifact already exists with different content: ${path}`)
    return
  }
  await writeFile(path, bytes, { flag: 'wx' })
}

function readArchive(sourceRoot: string, connectionId: string): z.infer<typeof archiveSchema> {
  const platform = new DatabaseSync(join(sourceRoot, 'platform.db'), { readOnly: true })
  let mastra: DatabaseSync | undefined
  try {
    mastra = new DatabaseSync(join(sourceRoot, 'mastra.db'), { readOnly: true })
    // Each connection pins a read transaction that includes committed WAL pages.
    platform.exec('BEGIN')
    mastra.exec('BEGIN')
    const select = (table: string) => platform.prepare(`SELECT * FROM ${table}`).all()
    return archiveSchema.parse({
      version: 1,
      sourceRoot,
      connectionId,
      createdAt: new Date().toISOString(),
      investigations: select('platform_investigation_runs'),
      profiles: select('platform_profile_generations'),
      snapshots: select('platform_profile_evidence_snapshots'),
      gitSources: select('platform_git_repositories'),
      workflows: mastra
        .prepare(
          'SELECT workflow_name, run_id, json(snapshot) AS snapshot, createdAt, updatedAt FROM mastra_workflow_snapshot WHERE workflow_name IN (?, ?)',
        )
        .all(...workflowNames),
    })
  } finally {
    platform.close()
    mastra?.close()
  }
}

async function copyTree(source: string, destination: string, manifest: Artifact[], base: string): Promise<void> {
  const root = await realpath(source)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const from = await realpath(join(root, entry.name))
    if (!inside(root, from) || entry.isSymbolicLink())
      throw new Error('Legacy artifacts must stay inside their original evidence directory')
    const to = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to, manifest, base)
      continue
    }
    if (!entry.isFile()) throw new Error('Legacy evidence contains a non-file entry')
    const bytes = await readFile(from)
    await immutableFile(to, bytes)
    manifest.push({
      id: relative(base, to).replaceAll('\\', '/'),
      relativePath: relative(base, to).replaceAll('\\', '/'),
      sizeBytes: bytes.length,
      sha256: digest(bytes),
    })
  }
}

function convertedResult(
  raw: Record<string, unknown>,
  connectionId: string,
  sourceKey: string,
  oldRoot: string,
  newRoot: string,
): InvestigationReportContent | null {
  const dossier = raw.dossier ? object(raw.dossier) : null
  if (!dossier || !Array.isArray(dossier.cases)) return null
  const identities = new Map<string, string>()
  for (const item of dossier.cases) {
    const oldCase = object(item)
    const id = string(oldCase.id)
    const report = string(oldCase.reportId)
    if (!id) return null
    if (report) {
      if (!string(oldCase.appId) || !string(oldCase.platformId) || !Number.isInteger(Number(oldCase.platformId)))
        return null
      identities.set(id, `${connectionId}:crash:${String(oldCase.appId)}:${String(oldCase.platformId)}:${report}`)
    } else identities.set(id, sourceKey)
  }
  const rewrite = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => rewrite(item))
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewrite(item, name)]))
    if (typeof value !== 'string') return value
    if (key === 'id' || key === 'caseId') return identities.get(value) ?? value
    if (['evidenceRoot', 'absolutePath', 'localPath', 'reportPath', 'packagePath'].includes(key)) {
      if (resolve(value) === resolve(oldRoot)) return newRoot
      if (inside(resolve(oldRoot), resolve(value))) return join(newRoot, relative(oldRoot, value))
    }
    return value
  }
  const transformed = object(rewrite(raw))
  transformed.dossier = { ...object(transformed.dossier), scope: connectionId }
  const parsed = investigationReportContentSchema.safeParse(transformed)
  return parsed.success ? parsed.data : null
}

/**
 * Archive the two source databases through read-only transactions, then import a frozen cutover.
 * @param input - offline destination owner, explicit source directory and application settings.
 * @returns verified counts; repeated imports reuse the frozen archive and never duplicate records.
 */
export async function importLegacy(input: {
  sourceRoot: string
  dataRoot: string
  sourceCodeRoot: string
  connectionId: string
  maxResultBytes: number
  store: WorkbenchStore
}): Promise<MigrationSummary> {
  const sourceRoot = await realpath(input.sourceRoot)
  const archiveRoot = join(input.dataRoot, 'legacy', digest(`${sourceRoot}\n${input.connectionId}`).slice(0, 24))
  if (inside(sourceRoot, resolve(input.dataRoot)) || resolve(input.dataRoot) === sourceRoot)
    throw new Error('Legacy import destination must be separate from the source')
  await mkdir(archiveRoot, { recursive: true })
  const archivePath = join(archiveRoot, 'records.json')
  const archive = (await exists(archivePath))
    ? archiveSchema.parse(JSON.parse(await readFile(archivePath, 'utf8')) as unknown)
    : readArchive(sourceRoot, input.connectionId)
  if (archive.sourceRoot !== sourceRoot || archive.connectionId !== input.connectionId)
    throw new Error('Legacy archive belongs to a different source or connection')
  await immutableFile(archivePath, Buffer.from(`${JSON.stringify(archive, null, 2)}\n`))
  const marker = digest(await readFile(archivePath))
  const summaryPath = join(archiveRoot, 'summary.json')
  if (input.store.domain.table('imported').get(marker))
    return JSON.parse(await readFile(summaryPath, 'utf8')) as MigrationSummary
  const artifacts = new ArtifactStore(join(input.dataRoot, 'artifacts'), input.maxResultBytes)
  const manifest: Artifact[] = []
  const sourceFiles = join(sourceRoot, '.incident-evidence')
  if (await exists(sourceFiles)) await copyTree(sourceFiles, join(archiveRoot, 'evidence'), manifest, archiveRoot)
  const platform = new Map(archive.investigations.map(row => [String(row.id), row]))
  const workflows = [...archive.workflows]
  for (const row of archive.investigations)
    if (!workflows.some(workflow => workflow.run_id === row.id))
      workflows.push({
        workflow_name: workflowNames[0],
        run_id: row.id,
        snapshot: {
          status: row.workflow_status,
          context: { input: { tapdUrl: row.tapd_url, additionalContext: row.additional_context } },
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
  const summary: MigrationSummary = {
    archive: archiveRoot,
    archivedRuns: workflows.length,
    importedRuns: 0,
    structuredRuns: 0,
    reportOnlyRuns: 0,
    orphanRuns: [],
    profiles: 0,
    publications: 0,
    files: manifest.length,
  }
  for (const row of workflows) {
    const legacyId = String(row.run_id)
    const snapshot = object(decoded(row.snapshot))
    const record = platform.get(legacyId)
    const context = snapshot.context ? object(snapshot.context) : {}
    const request = context.input ? object(context.input) : {}
    const raw = snapshot.result ? object(snapshot.result) : null
    const oldDossier = raw?.dossier ? object(raw.dossier) : null
    const ticket = oldDossier?.ticket ? object(oldDossier.ticket) : null
    const tapdUrl = string(request.tapdUrl) ?? string(record?.tapd_url) ?? string(ticket?.url)
    if (!tapdUrl) {
      summary.orphanRuns.push(legacyId)
      continue
    }
    const reference = parseTapdReference(tapdUrl)
    const sourceKey = `${input.connectionId}:tapd:${reference.workspaceId}:${reference.objectType}:${reference.workItemId}`
    const id = runIdSchema.parse(uuid(`${marker}:${String(row.workflow_name)}:${legacyId}`))
    const planId = planIdSchema.parse(uuid(`${id}:legacy-plan`))
    const directory = artifacts.directory(id)
    const oldEvidenceRoot = string(oldDossier?.evidenceRoot) ?? join(sourceFiles, legacyId)
    const copiedRoot = join(directory, 'legacy-files')
    const preserved = join(archiveRoot, 'evidence', legacyId)
    if (await exists(preserved)) await copyTree(preserved, copiedRoot, [], directory)
    const converted = raw ? convertedResult(raw, input.connectionId, sourceKey, oldEvidenceRoot, copiedRoot) : null
    const registered: Artifact[] = []
    await immutableFile(
      join(directory, 'input.json'),
      Buffer.from(
        `${JSON.stringify({ legacyRunId: legacyId, workflow: row.workflow_name, input: request, platform: record ?? null }, null, 2)}\n`,
      ),
    )
    registered.push(await artifacts.register(id, 'input', 'input.json'))
    if (raw) {
      await immutableFile(join(directory, 'legacy-result.json'), Buffer.from(`${JSON.stringify(raw, null, 2)}\n`))
      registered.push(await artifacts.register(id, 'legacy-result', 'legacy-result.json'))
    }
    const report = string(raw?.markdown)
    if (report) {
      const archivedReport = join(preserved, 'report.md')
      const reportBytes = (await exists(archivedReport)) ? await readFile(archivedReport) : Buffer.from(report)
      const expectedHash = string(record?.report_content_hash)
      if (expectedHash && digest(reportBytes) !== expectedHash)
        throw new Error(`Legacy report hash failed: ${legacyId}`)
      await immutableFile(join(directory, 'report.md'), reportBytes)
      registered.push(await artifacts.register(id, 'report', 'report.md'))
    }
    if (converted) {
      await immutableFile(join(directory, 'result.json'), Buffer.from(`${JSON.stringify(converted, null, 2)}\n`))
      registered.push(await artifacts.register(id, 'result', 'result.json'))
      summary.structuredRuns++
    } else if (report) summary.reportOnlyRuns++
    const samples = (converted?.dossier.cases ?? []).flatMap(item =>
      item.appId && item.platformId && item.reportId
        ? [
          {
            appId: item.appId,
            platformId: Number(item.platformId),
            issueId: item.issueId,
            crashHash: item.reportId,
            crashId: null,
            version: item.sourceVersion.buildVersion,
            uploadedAt: null,
          },
        ]
        : [],
    )
    const rawStatus =
      string(record?.platform_status_override) ?? string(snapshot.status) ?? string(record?.workflow_status)
    const status: RunRecord['status'] = report
      ? (converted?.status ?? 'completed')
      : rawStatus === 'failed'
        ? 'failed'
        : rawStatus === 'canceled'
          ? 'canceled'
          : 'interrupted'
    const run = runRecordSchema.parse({
      id,
      planId,
      confirmedPlanIds: [planId],
      sourceKey,
      sourceKeys: [sourceKey],
      target: { kind: 'tapd', url: tapdUrl },
      title: string(raw?.title) ?? string(ticket?.title) ?? `旧调查 ${legacyId}`,
      mode: row.workflow_name === workflowNames[1] ? 'dual' : 'single',
      samples,
      caseKeys: converted?.dossier.cases.map(item => item.id) ?? [sourceKey],
      additionalContext: string(request.additionalContext) ?? '',
      sourceRoot: input.sourceCodeRoot,
      configurationDigest: `legacy:${marker}`,
      status,
      phase: 'finished',
      completedCases: converted?.cases.length ?? 0,
      totalCases: converted?.cases.length ?? 0,
      createdAt: string(record?.created_at) ?? String(row.createdAt),
      updatedAt: string(record?.updated_at) ?? String(row.updatedAt),
      finishedAt: string(record?.finished_at) ?? String(row.updatedAt),
      error: string(record?.error_message),
      artifacts: registered,
      legacyRunId: legacyId,
      legacyLimitation:
        report && !converted ? '旧版结构无法完整转换。原报告和结构化输出已归档，此记录不计入新的画像证据。' : null,
    })
    const existing = input.store.domain.table('runs').get(id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(run))
      throw new Error(`Imported investigation changed: ${id}`)
    if (!existing) await input.store.domain.table('runs').put(id, run)
    summary.importedRuns++
  }
  for (const row of archive.snapshots) {
    const snapshot = personalProfileEvidenceSnapshotSchema.parse(decoded(row.snapshot))
    await input.store.domain.table('evidence').put(snapshot.id, snapshot)
  }
  const versions = []
  for (const row of archive.profiles) {
    const id = profileIdSchema.parse(row.id)
    const content = row.profile ? personalProfileContentSchema.parse(decoded(row.profile)) : null
    if (content && !input.store.domain.table('evidence').get(content.sourceSnapshotId))
      throw new Error('Published profile refers to a missing evidence snapshot')
    const evidenceIds = new Set(content?.evidence.map(item => item.id))
    if (content?.claims.some(claim => claim.evidenceRefs.some(ref => !evidenceIds.has(ref))))
      throw new Error('Legacy profile contains an unresolved evidence reference')
    const draft = profileRecordSchema.parse({
      id,
      snapshotId: row.source_snapshot_id,
      status: content ? 'completed' : row.workflow_status === 'failed' ? 'failed' : 'interrupted',
      revision: content ? 1 : 0,
      content,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error_message,
    })
    await input.store.domain.table('profiles').put(id, draft)
    summary.profiles++
    if (content && (row.publication_status === 'published' || row.publication_status === 'superseded')) {
      const publication = publicationSchema.parse({
        id: uuid(`${id}:publication`),
        generationId: id,
        version: row.version,
        publishedAt: row.published_at,
        content,
      })
      if (content.claims.some(claim => claim.reviewStatus !== 'confirmed'))
        throw new Error('Legacy publication contains an unreviewed claim')
      await input.store.domain.table('publications').put(publication.id, publication)
      versions.push(publication)
      summary.publications++
    }
  }
  const current = input.store.domain.table('control').get('current')
  if (!current) throw new Error('The import destination has no control record')
  const latestEvidence = [...input.store.domain.table('evidence').entries()]
    .map(([, value]) => value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  const latestVersion = versions.sort((a, b) => b.version - a.version)[0]
  if (current.publishedId && latestVersion && current.publishedId !== latestVersion.id)
    throw new Error('Import cannot replace an existing DSH publication')
  await input.store.domain
    .table('control')
    .put('current', {
      publishedId: latestVersion?.id ?? current.publishedId,
      evidenceId: current.evidenceId ?? latestEvidence?.id ?? null,
    })
  await immutableFile(join(archiveRoot, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  await immutableFile(summaryPath, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`))
  await input.store.domain.table('imported').put(marker, { manifest, importedAt: new Date().toISOString() })
  return summary
}
