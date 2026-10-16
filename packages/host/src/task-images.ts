/** Task-owned raster files; journal serialization excludes writes during collection. */
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { readBriefImage } from './brief-images.ts'
import { storageFiles } from './storage.ts'

const format = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const destination = /^personal-image:v2:([a-f0-9]{64})\.(png|jpeg|webp|gif)$/

/** Extract durable image references, including references copied into ordinary text.
 * @param text Task description or retained event text.
 * @returns Unique versioned destinations.
 */
export function taskImageReferences(text: string): string[] {
  return [...new Set(text.match(/personal-image:v(?:1:[A-Za-z0-9_-]+|2:[a-f0-9]{64}\.(?:png|jpeg|webp|gif))/g) ?? [])]
}

/** Dedicated files never share ownership with native conversation attachments. */
export class TaskImages {
  constructor(private readonly root: string, private readonly attachments: AttachmentStore,
    private readonly retentionMs: number) {}

  /** Validate and publish an image without creating a shared session attachment.
   * @param encoded Canonical base64 raster bytes.
   * @param mediaType Declared raster format.
   * @returns Copyable Markdown destination.
   */
  async upload(encoded: string, mediaType: string): Promise<string> {
    const type = format.parse(mediaType)
    if (encoded.length > Math.ceil(this.attachments.imageLimits.maxImageBytes / 3) * 4)
      throw new Error('Task image exceeds the configured image byte limit')
    const data = Buffer.from(encoded, 'base64')
    if (!data.length || data.toString('base64') !== encoded) throw new Error('Invalid task image encoding')
    if (data.length > this.attachments.imageLimits.maxImageBytes) throw new Error('Task image exceeds the configured image byte limit')
    await this.attachments.validateImage({ data, mediaType: type })
    await mkdir(this.root, { recursive: true })
    // Refuse link-shaped storage before any read, write or cleanup.
    await storageFiles(this.root)
    const name = `${createHash('sha256').update(data).digest('hex')}.${type.slice(6)}`
    const path = join(this.root, name)
    const temporary = join(this.root, `.upload-${randomUUID()}`)
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      try { await link(temporary, path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readFile(path)
        if (!existing.equals(data)) throw new Error('Task image storage is inconsistent')
      }
    } finally {
      try { await unlink(temporary) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const now = new Date()
    await utimes(path, now, now)
    return `personal-image:v2:${name}`
  }

  /** Resolve current and legacy images without changing their retention dates.
   * @param value Durable Markdown destination.
   * @returns Raster data URL for the authenticated reader.
   */
  async read(value: string): Promise<string> {
    if (value.startsWith('personal-image:v1:')) return readBriefImage(this.attachments, value)
    const match = destination.exec(value)
    if (!match) throw new Error('Invalid task image reference')
    await storageFiles(this.root)
    let data: Buffer
    try { data = await readFile(join(this.root, `${match[1]}.${match[2]}`)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Task image has expired or is missing; paste the image again')
      throw error
    }
    if (createHash('sha256').update(data).digest('hex') !== match[1]) throw new Error('Task image storage is inconsistent')
    return `data:image/${match[2]};base64,${data.toString('base64')}`
  }

  /** Reject saves and undo operations that would introduce broken owned images.
   * @param text Proposed task description.
   */
  async validate(text: string): Promise<void> {
    for (const ref of taskImageReferences(text)) await this.read(ref)
  }

  /** Remove expired files only when no current task needs them.
   * @param references Reference deadlines: Infinity for current tasks; event timestamp for history.
   * @param now Collection time in milliseconds.
   * @returns Number of physically removed files.
   */
  async collect(references: ReadonlyMap<string, number>, now: number): Promise<number> {
    let removed = 0
    for (const file of await storageFiles(this.root)) {
      const ref = `personal-image:v2:${basename(file.path)}`
      if (!destination.test(ref) && !/^\.upload-[a-f0-9-]{36}$/.test(basename(file.path))) continue
      const protectedUntil = Math.max(file.modifiedAt + this.retentionMs, (references.get(ref) ?? 0) + this.retentionMs)
      if (protectedUntil > now) continue
      await unlink(file.path)
      removed++
    }
    return removed
  }
}
