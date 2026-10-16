/** Owned storage accounting, admission limits and reference-aware cleanup previews. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, statfs } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { inside } from './artifacts.ts'
import type { Config } from './config.ts'
import { profileIdSchema, runIdSchema } from './models.ts'
import type { WorkbenchStore } from './store.ts'

/** Digest binding a cleanup to a reviewed set of unreferenced records and files. */
export type CleanupToken = Branded<'PersonalWorkbenchCleanupToken'>
/** Measured logical bytes; hard links and filesystem compression can change physical recovery. */
export interface StorageUsage {
  totalBytes: number
  fileBytes: number
  recordBytes: number
  files: number
  freeBytes: number
  limitBytes: number
  maxRunBytes: number
  retention: Config['storage']
  groups: { name: string; bytes: number; files: number }[]
}
/** One feature-owned deletion candidate, never a caller-supplied filesystem path. */
export interface CleanupCandidate {
  id: string
  kind: 'temporary' | 'snapshot' | 'draft' | 'run'
  label: string
  bytes: number
  reason: string
}
/** A preview is invalidated by any change to its candidate set or protected references. */
export interface CleanupPreview {
  token: CleanupToken
  includeHistory: boolean
  candidates: CleanupCandidate[]
  recoverableBytes: number
  protectedRuns: number
  protectedSnapshots: number
  publications: number
  usage: StorageUsage
}
/** Completed cleanup facts, with filesystem failure preserved for retry. */
export interface CleanupResult {
  removed: number
  recoveredBytes: number
  usage: StorageUsage
}

interface DiskFile {
  path: string
  size: number
  modifiedAt: number
}

/**
 * Enumerate regular files without following links or escaping the configured root.
 * @param root - owned absolute directory.
 * @returns measured files; an absent directory has no files.
 */
export async function storageFiles(root: string): Promise<DiskFile[]> {
  const result: DiskFile[] = []
  let canonical: string
  try {
    canonical = await realpath(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const inspect = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('Storage contains a link; automatic cleanup refuses to follow it')
    const actual = await realpath(path)
    if (actual !== canonical && !inside(canonical, actual)) throw new Error('Storage path escaped its owner')
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await walk(join(path, entry))
    } else if (info.isFile()) result.push({ path: actual, size: info.size, modifiedAt: info.mtimeMs })
    else throw new Error('Storage contains a non-regular file')
  }
  const walk = async (path: string): Promise<void> => {
    try {
      await inspect(path)
    } catch (error) {
      // Quiescent cleanup and active worker-cache teardown can overlap accounting.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await walk(canonical)
  return result
}

/**
 * Remove a quiescent path only after checking its final root and every descendant.
 * @param root - directory exclusively owned by the feature.
 * @param path - internally selected descendant; the root itself is forbidden.
 */
export async function removeOwnedPath(root: string, path: string): Promise<void> {
  const canonical = await realpath(root)
  let target: string
  try {
    target = await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!inside(canonical, target) || (await lstat(path)).isSymbolicLink())
    throw new Error('Cleanup target is outside its owner')
  await storageFiles(target)
  await rm(target, { recursive: true, force: true })
}

/** Streaming byte reservation; rejected writes cannot exceed the run's cumulative allowance. */
export class RunBudget {
  private used: number
  constructor(
    private readonly maxBytes: number,
    initialBytes: number,
  ) {
    this.used = initialBytes
  }
  /**
   * Reserve bytes before sending them to disk; failed writes keep a conservative reservation.
   * @param bytes - nonnegative upcoming write size.
   */
  charge(bytes: number): void {
    if (this.used + bytes > this.maxBytes)
      throw new Error('本次任务已达到存储上限，已停止继续下载或写入；已保存的材料仍可查看')
    this.used += bytes
  }
}

/** Storage mutations run inside the business owner's serialized commit. */
export class WorkbenchStorage {
  constructor(
    private readonly config: Config,
    private readonly store: WorkbenchStore,
  ) {}

  /**
   * Measure feature files and serialized records without reading evidence contents.
   * @returns logical occupancy and free filesystem capacity.
   */
  async usage(): Promise<StorageUsage> {
    const files = await storageFiles(this.config.dataRoot)
    const groups = new Map<string, { name: string; bytes: number; files: number }>()
    for (const file of files) {
      const name = relative(this.config.dataRoot, file.path).replace(/[\\/].*$/, '')
      const group = groups.get(name) ?? { name, bytes: 0, files: 0 }
      group.bytes += file.size
      group.files++
      groups.set(name, group)
    }
    const recordBytes = this.store.bytes()
    const filesystem = await statfs(this.config.dataRoot)
    const fileBytes = files.reduce((sum, file) => sum + file.size, 0)
    return {
      totalBytes: fileBytes + recordBytes,
      fileBytes,
      recordBytes,
      files: files.length,
      freeBytes: filesystem.bavail * filesystem.bsize,
      limitBytes: this.config.storage.maxBytes,
      maxRunBytes: this.config.storage.maxRunBytes,
      retention: this.config.storage,
      groups: [...groups.values()],
    }
  }

  /**
   * Reserve enough capacity for admitted executions before another model or download starts.
   * @param active - count of already admitted executions, each with a run allowance.
   */
  async admit(active: number): Promise<void> {
    const usage = await this.usage()
    const reserve = (active + 1) * (this.config.storage.maxRunBytes + this.config.maxResultBytes)
    if (usage.totalBytes + reserve > usage.limitBytes)
      throw new Error('工作台存储额度不足，请先到“存储管理”预览清理，或调整额度')
    if (usage.freeBytes - reserve < this.config.storage.minFreeBytes)
      throw new Error('磁盘剩余空间不足，已暂停启动新任务')
  }

  /**
   * Admit a bounded source-cache or evidence-record write.
   * @param bytes - additional serialized bytes about to be retained.
   * @param active - admitted executions whose reservations must remain available.
   */
  async admitRecord(bytes: number, active: number): Promise<void> {
    const usage = await this.usage()
    const reserve = active * (this.config.storage.maxRunBytes + this.config.maxResultBytes)
    if (
      usage.totalBytes + bytes + reserve > usage.limitBytes ||
      usage.freeBytes - bytes - reserve < this.config.storage.minFreeBytes
    )
      throw new Error('工作台存储额度不足，已保留上次成功的数据；请先预览清理')
  }

  /** Restore quarantined directories if their record deletion never committed. */
  async recover(): Promise<void> {
    const root = await realpath(this.config.dataRoot)
    const trash = join(root, '.trash')
    let names: string[]
    try {
      names = await readdir(trash)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      const match = /^(artifacts|profiles)-([0-9a-f-]{36})$/.exec(name)
      const folder = match?.[1]
      const id = match?.[2]
      if (!folder || !id) throw new Error('Unrecognized cleanup quarantine entry')
      const source = join(trash, name)
      const target = join(root, folder, id)
      const record =
        folder === 'artifacts'
          ? this.store.domain.table('runs').get(runIdSchema.parse(id))
          : this.store.domain.table('profiles').get(profileIdSchema.parse(id))
      if (!record) {
        await removeOwnedPath(root, source)
        continue
      }
      if (!inside(root, await realpath(source)) || (await lstat(source)).isSymbolicLink())
        throw new Error('Cleanup quarantine escaped its owner')
      await storageFiles(source)
      try {
        await lstat(target)
        throw new Error('Both live and quarantined artifacts exist; recovery refuses to overwrite either')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await mkdir(join(root, folder), { recursive: true })
      await rename(source, target)
    }
  }

  /**
   * Find expired unreferenced data; completed investigations require explicit history cleanup.
   * @param includeHistory - whether old terminal investigations may be proposed.
   * @returns reviewable deletion set and retained publication references.
   */
  async preview(includeHistory: boolean): Promise<CleanupPreview> {
    const now = Date.now()
    const day = 86_400_000
    const domain = this.store.domain
    const control = domain.table('control').get('current')
    assert(control, 'The workbench store initializes its current pointers')
    const publications = [...domain.table('publications').entries()].map(([, value]) => value)
    const drafts = [...domain.table('profiles').entries()].map(([, value]) => value)
    const evidence = [...domain.table('evidence').entries()].map(([, value]) => value)
    const runs = [...domain.table('runs').entries()].map(([, value]) => value)
    const protectedSnapshots = new Set([
      ...(control.evidenceId ? [control.evidenceId] : []),
      ...drafts.map(draft => draft.snapshotId),
      ...publications.map(item => item.content.sourceSnapshotId),
    ])
    const facts = [
      ...evidence.flatMap(snapshot => snapshot.evidence),
      ...publications.flatMap(item => item.content.evidence),
      ...drafts.flatMap(draft => draft.content?.evidence ?? []),
    ]
    const protectedRuns = new Set(facts.flatMap(item => (item.sourceRunId ? [item.sourceRunId] : [])))
    const unmappedLegacy = facts.some(item => item.kind === 'investigation' && !item.sourceRunId)
    for (const run of runs) {
      if (['queued', 'running', 'stopping'].includes(run.status) || (unmappedLegacy && run.legacyRunId))
        protectedRuns.add(run.id)
    }
    const publishedDrafts = new Set(publications.map(item => item.generationId))
    const files = await storageFiles(this.config.dataRoot)
    const candidates: CleanupCandidate[] = []
    const diskBytes = (path: string) =>
      files.filter(file => inside(resolve(path), file.path)).reduce((sum, file) => sum + file.size, 0)
    for (const snapshot of evidence)
      if (
        !protectedSnapshots.has(snapshot.id) &&
        Date.parse(snapshot.createdAt) < now - this.config.storage.snapshotRetentionDays * day
      ) {
        candidates.push({
          kind: 'snapshot',
          id: snapshot.id,
          label: snapshot.createdAt,
          bytes: Buffer.byteLength(JSON.stringify(snapshot)),
          reason: '过期材料快照，无草稿或发布版本引用',
        })
      }
    for (const draft of drafts)
      if (
        !['running', 'stopping'].includes(draft.status) &&
        !publishedDrafts.has(draft.id) &&
        !draft.content?.claims.some(claim => claim.reviewStatus !== 'pending') &&
        Date.parse(draft.updatedAt) < now - this.config.storage.draftRetentionDays * day
      ) {
        candidates.push({
          kind: 'draft',
          id: draft.id,
          label: draft.createdAt,
          bytes: diskBytes(join(this.config.dataRoot, 'profiles', draft.id)) + Buffer.byteLength(JSON.stringify(draft)),
          reason: '过期且未审核、未发布的生成记录',
        })
      }
    if (includeHistory)
      for (const run of runs)
        if (
          !protectedRuns.has(run.id) &&
          Date.parse(run.finishedAt ?? run.updatedAt) < now - this.config.storage.runRetentionDays * day
        ) {
          candidates.push({
            kind: 'run',
            id: run.id,
            label: run.title,
            bytes: diskBytes(join(this.config.dataRoot, 'artifacts', run.id)) + Buffer.byteLength(JSON.stringify(run)),
            reason: '过期调查，未被材料、草稿或发布版本引用',
          })
        }
    const activeIds = new Set<string>([
      ...runs.filter(run => ['queued', 'running', 'stopping'].includes(run.status)).map(run => run.id),
      ...drafts.filter(draft => ['running', 'stopping'].includes(draft.status)).map(draft => draft.id),
    ])
    const root = await realpath(this.config.dataRoot)
    for (const file of files) {
      const path = relative(root, file.path).replaceAll('\\', '/')
      const parts = path.split('/')
      if (parts[0] === 'legacy' || parts[0] === '.trash' || activeIds.has(parts[1] ?? '')) continue
      const stale = file.modifiedAt < now - this.config.storage.temporaryRetentionHours * 3_600_000
      const orphan =
        (parts[0] === 'artifacts' && !runs.some(run => run.id === parts[1])) ||
        (parts[0] === 'profiles' && !drafts.some(draft => draft.id === parts[1]))
      const run = runs.find(run => run.id === parts[1])
      const partial =
        run &&
        ['failed', 'canceled', 'interrupted'].includes(run.status) &&
        path.endsWith('.partial') &&
        !run.artifacts.some(artifact => path === `artifacts/${run.id}/${artifact.relativePath}`)
      if (stale && (partial || orphan || parts.some(part => part.endsWith('.codex-cache')))) {
        candidates.push({
          kind: 'temporary',
          id: path,
          label: path,
          bytes: file.size,
          reason: '已结束任务留下的过期临时文件',
        })
      }
    }
    for (const folder of ['artifacts', 'profiles']) {
      let entries: string[]
      try {
        entries = await readdir(join(root, folder))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const id of entries) {
        const parsed = folder === 'artifacts' ? runIdSchema.safeParse(id) : profileIdSchema.safeParse(id)
        if (!parsed.success || runs.some(run => run.id === id) || drafts.some(draft => draft.id === id)) continue
        const path = join(root, folder, id)
        const info = await lstat(path)
        if (
          info.isDirectory() &&
          info.mtimeMs < now - this.config.storage.temporaryRetentionHours * 3_600_000 &&
          !files.some(file => inside(path, file.path))
        ) {
          candidates.push({
            kind: 'temporary',
            id: `${folder}/${id}`,
            label: `${folder}/${id}`,
            bytes: 0,
            reason: '已过期且没有记录引用的空任务目录',
          })
        }
      }
    }
    candidates.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`))
    const token = brandString<CleanupToken>(
      createHash('sha256')
        .update(
          JSON.stringify({
            candidates,
            protectedRuns: [...protectedRuns].sort(),
            protectedSnapshots: [...protectedSnapshots].sort(),
            revision: this.store.revision(),
          }),
        )
        .digest('hex'),
    )
    return {
      token,
      includeHistory,
      candidates,
      recoverableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
      protectedRuns: protectedRuns.size,
      protectedSnapshots: protectedSnapshots.size,
      publications: publications.length,
      usage: await this.usage(),
    }
  }

  /**
   * Revalidate a preview, quarantine owned directories, then remove their records and files.
   * @param token - digest returned by the displayed preview.
   * @param includeHistory - scope displayed in that preview.
   * @returns completed removals and new measured usage.
   */
  async clean(token: CleanupToken, includeHistory: boolean): Promise<CleanupResult> {
    const preview = await this.preview(includeHistory)
    if (preview.token !== token) throw new Error('清理对象或引用关系已变化，请重新预览')
    const root = await realpath(this.config.dataRoot)
    for (const item of preview.candidates) {
      if (item.kind === 'temporary') {
        await removeOwnedPath(root, resolve(root, item.id))
      } else if (item.kind === 'snapshot') {
        await this.store.domain.table('evidence').delete(item.id)
      } else {
        const folder = item.kind === 'run' ? 'artifacts' : 'profiles'
        const from = resolve(root, folder, item.id)
        const to = resolve(root, '.trash', `${folder}-${item.id}`)
        if (!inside(root, from) || !inside(root, to)) throw new Error('Cleanup directory escaped its owner')
        const files = await storageFiles(from)
        if (files.length) {
          await mkdir(join(root, '.trash'), { recursive: true })
          await rename(from, to)
        }
        try {
          if (item.kind === 'run') await this.store.domain.table('runs').delete(runIdSchema.parse(item.id))
          else await this.store.domain.table('profiles').delete(profileIdSchema.parse(item.id))
        } catch (error) {
          if (files.length) await rename(to, from)
          throw error
        }
        if (files.length) await removeOwnedPath(root, to)
      }
    }
    await this.removeEmptyDirectories(preview.candidates)
    return { removed: preview.candidates.length, recoveredBytes: preview.recoverableBytes, usage: await this.usage() }
  }

  private async removeEmptyDirectories(candidates: CleanupCandidate[]): Promise<void> {
    const root = await realpath(this.config.dataRoot)
    const visit = async (path: string): Promise<void> => {
      let names: string[]
      try {
        names = await readdir(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const name of names) {
        const child = join(path, name)
        const info = await lstat(child)
        if (info.isSymbolicLink() || !inside(root, await realpath(child)))
          throw new Error('Cleanup refuses linked directories')
        if (info.isDirectory()) await visit(child)
      }
      try {
        await rmdir(path)
      } catch (error) {
        if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
    for (const folder of ['artifacts', 'profiles']) {
      const base = join(root, folder)
      const names = new Set(
        candidates.flatMap((item) => {
          if (item.kind === 'temporary' && item.id.startsWith(`${folder}/`)) return [item.id.split('/')[1] ?? '']
          return (folder === 'artifacts' && item.kind === 'run') || (folder === 'profiles' && item.kind === 'draft')
            ? [item.id]
            : []
        }),
      )
      for (const id of names) {
        const parsed = folder === 'artifacts' ? runIdSchema.safeParse(id) : profileIdSchema.safeParse(id)
        if (!parsed.success) continue
        const exists =
          folder === 'artifacts'
            ? this.store.domain.table('runs').get(runIdSchema.parse(id))
            : this.store.domain.table('profiles').get(profileIdSchema.parse(id))
        if (!exists) {
          const path = join(base, id)
          let info
          try {
            info = await lstat(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw error
          }
          if (info.isSymbolicLink() || !inside(root, await realpath(path)))
            throw new Error('Cleanup refuses linked directories')
          if (info.isDirectory()) await visit(path)
        }
      }
    }
  }
}
