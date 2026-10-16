/** Immutable run artifacts, verified by registered identity, real path, size and SHA-256. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Artifact, RunId, EvidencePreview } from './models.ts'

/**
 * Test whether a resolved path is inside an owned directory.
 * @param root - canonical owning directory.
 * @param path - canonical target.
 * @returns whether target is a descendant rather than the root or a sibling.
 */
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

/** Filesystem adapter; business records select which artifacts readers may access. */
export class ArtifactStore {
  constructor(
    readonly root: string,
    private readonly maxBytes: number,
  ) {}

  /**
   * Resolve a UUID-owned run directory.
   * @param id - parsed durable run identity.
   * @returns absolute artifact directory.
   */
  directory(id: RunId): string {
    return join(this.root, id)
  }

  /**
   * Write a new artifact without overwriting an earlier result.
   * @param id - owning run.
   * @param name - business-owned filename, never a caller path.
   * @param value - serializable record.
   */
  async json(id: RunId, name: string, value: unknown): Promise<void> {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > this.maxBytes) throw new Error('Artifact exceeds the configured byte limit')
    const directory = this.directory(id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), text, { flag: 'wx' })
  }

  /**
   * Read a bounded window while verifying the entire evidence file against its frozen hash.
   * @param id - owning investigation.
   * @param file - authoritative Case evidence metadata, never request-supplied paths.
   * @param offset - byte offset within this file.
   * @param maxBytes - preview response budget.
   * @param signal - owning read lifetime.
   * @returns verified UTF-8 text and the next byte offset.
   */
  async preview(
    id: RunId,
    file: { evidenceId: string; name: string; absolutePath: string; sizeBytes: number; sha256: string },
    offset: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<EvidencePreview> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.sizeBytes)
      throw new Error('Invalid evidence offset')
    const root = await this.checkedDirectory(id)
    // Captured absolute paths retain their original machine prefix after a home migration.
    const recorded = file.absolutePath.replaceAll('\\', '/')
    const owner = `/${basename(this.root)}/${id}/`
    const start = recorded.lastIndexOf(owner)
    if (start < 0) throw new Error('Evidence path is outside its investigation directory')
    const candidate = resolve(root, recorded.slice(start + owner.length))
    if (!inside(root, candidate)) throw new Error('Evidence path is outside its investigation directory')
    const path = await realpath(candidate)
    if (!inside(root, path)) throw new Error('Evidence path is outside its investigation directory')
    const info = await stat(path)
    if (!info.isFile() || info.size !== file.sizeBytes) throw new Error('Evidence size changed')
    const hash = createHash('sha256')
    const selected: Buffer[] = []
    let bytes = 0
    for await (const value of createReadStream(path, { signal })) {
      const chunk = value as Buffer
      hash.update(chunk)
      const start = Math.max(0, offset - bytes)
      const end = Math.min(chunk.length, offset + maxBytes + 4 - bytes)
      if (start < end) selected.push(chunk.subarray(start, end))
      bytes += chunk.length
    }
    if (bytes !== file.sizeBytes || hash.digest('hex') !== file.sha256) throw new Error('Evidence content changed')
    const buffer = Buffer.concat(selected)
    let end = Math.min(maxBytes, buffer.length)
    while (end > 0 && end < buffer.length && (buffer.readUInt8(end) & 0xc0) === 0x80) end--
    return {
      id: file.evidenceId,
      name: file.name,
      totalBytes: file.sizeBytes,
      offset,
      nextOffset: offset + end < file.sizeBytes ? offset + end : null,
      content: buffer.subarray(0, end).toString('utf8'),
    }
  }

  /**
   * Register an existing file only after containment and size checks.
   * @param runId - owning run.
   * @param id - feature-owned artifact identity.
   * @param name - path relative to the owned run directory.
   * @returns immutable file facts for the durable run record.
   */
  async register(runId: RunId, id: string, name: string): Promise<Artifact> {
    const root = await this.checkedDirectory(runId)
    const path = await realpath(resolve(root, name))
    if (!inside(root, path)) throw new Error('Artifact path is outside its investigation directory')
    const info = await stat(path)
    if (!info.isFile() || info.size > this.maxBytes)
      throw new Error('Artifact is not a file within the configured byte limit')
    const bytes = await readFile(path)
    if (bytes.length > this.maxBytes) throw new Error('Artifact exceeds the configured byte limit')
    return {
      id,
      relativePath: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    }
  }

  /**
   * Read exactly the content committed by a completed run.
   * @param runId - owning run.
   * @param artifact - recorded file facts, never request-supplied facts.
   * @returns verified bytes.
   */
  async read(runId: RunId, artifact: Artifact): Promise<Buffer> {
    const root = await this.checkedDirectory(runId)
    const path = await realpath(resolve(root, artifact.relativePath))
    if (!inside(root, path)) throw new Error('Artifact path is outside its investigation directory')
    const info = await stat(path)
    if (!info.isFile() || info.size !== artifact.sizeBytes || info.size > this.maxBytes)
      throw new Error('Artifact size differs from its registered result')
    const bytes = await readFile(path)
    if (bytes.length !== artifact.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error('Artifact content differs from its registered result')
    return bytes
  }

  private async checkedDirectory(runId: RunId): Promise<string> {
    const root = await realpath(this.root)
    const directory = await realpath(this.directory(runId))
    if (!inside(root, directory)) throw new Error('Investigation directory is outside the artifact root')
    return directory
  }
}
