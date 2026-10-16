import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { TaskImages } from '../src/task-images.ts'
import { WorkJournal, type JournalId, type JournalWrite } from '../src/journal.ts'
import { harness } from './helpers.ts'
import { saveBriefImage, readBriefImage } from '../src/brief-images.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAaQAAACMCAIAAAC8pkqNAAAB6ElEQVR4nO3UMQ0AIADAMPxL5OfEAy4gYU0qYNfGXBvge+N5AcAFZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkGB2QILZAQlmBySYHZBgdkCC2QEJZgckmB2QYHZAgtkBCWYHJJgdkHAAqy7WLOX14OMAAAAASUVORK5CYII='
it('retains a screenshot after the store is reopened without putting bytes in the description', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'personal-task-image-'))
  const ctx = new Context()
  const reopened = new Context()
  try {
    const first = new LocalAttachmentStore(ctx, { dshHome })
    const destination = await saveBriefImage(first, png, 'image/png')
    expect(destination).toMatch(/^personal-image:v1:/)
    expect(destination).not.toContain(png)
    const second = new LocalAttachmentStore(reopened, { dshHome })
    expect(await readBriefImage(second, destination)).toMatch(/^data:image\/png;base64,/)
    await expect(saveBriefImage(first, 'invalid', 'image/png')).rejects.toThrow()
    await expect(saveBriefImage(first, png, 'image/svg+xml')).rejects.toThrow()
    await expect(readBriefImage(first, 'file:///etc/passwd')).rejects.toThrow('Invalid task image reference')
    await expect(readBriefImage(first, 'personal-image:v1:e30')).rejects.toThrow()
  } finally {
    await reopened.fiber.dispose()
    await ctx.fiber.dispose()
    await rm(dshHome, { recursive: true, force: true })
  }
})

it('physically collects deleted images after retention, protects shared tasks, and refuses broken undo', async () => {
  const h = await harness()
  const native = new LocalAttachmentStore(h.ctx, { dshHome: h.root })
  const root = join(h.root, 'task-images')
  const retention = 7 * 86_400_000
  const images = new TaskImages(root, native, retention)
  let journal = await WorkJournal.open(h.ctx, 20, 1_048_576, images)
  const id = () => randomUUID() as JournalId
  const create = (description: string): JournalWrite => ({ requestId: id(), itemId: id(),
    expectedRevision: 0, operation: 'create', title: 'Image lifecycle', description,
    day: '2026-09-20', reason: 'Image lifecycle fixture' })
  try {
    const destination = await journal.uploadImage(png, 'image/png')
    expect(destination).toMatch(/^personal-image:v2:[a-f0-9]{64}\.png$/)
    expect(await journal.uploadImage(png, 'image/png')).toBe(destination)
    expect(await readdir(root)).toHaveLength(1)
    const first = create(`![image](${destination})`)
    const second = create(first.description!)
    await journal.write(first)
    await journal.write(second)
    const { description: _firstDescription, ...firstChange } = first
    const { description: _secondDescription, ...secondChange } = second
    const deleted = await journal.write({ ...firstChange, requestId: id(), expectedRevision: 1, operation: 'delete' })
    await journal.close()
    journal = await WorkJournal.open(h.ctx, 20, 1_048_576, images)
    expect(await journal.collectImages()).toBe(0)
    expect(await journal.readImage(destination)).toBe(`data:image/png;base64,${png}`)
    await journal.write({ ...firstChange, requestId: id(), expectedRevision: deleted.revision, operation: 'undo' })
    await journal.write({ ...firstChange, requestId: id(), expectedRevision: 3, operation: 'delete' })
    const future = Date.now() + retention + 1000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(future)
    try {
      // The second current task is sufficient even when every old event has expired.
      expect(await journal.collectImages()).toBe(0)
      await journal.write({ ...secondChange, requestId: id(), expectedRevision: 1, operation: 'delete' })
      expect(await journal.collectImages()).toBe(0)
      vi.setSystemTime(future + retention + 1000)
      expect(await journal.collectImages()).toBe(1)
      expect(await readdir(root)).toEqual([])
      await expect(journal.readImage(destination)).rejects.toThrow('expired or is missing')
      await expect(journal.write({ ...secondChange, requestId: id(), expectedRevision: 2, operation: 'undo' }))
        .rejects.toThrow('expired or is missing')
    } finally { vi.useRealTimers() }
  } finally { await journal.close(); await h.close() }
})

it('collects abandoned uploads and removed images without deleting shared native attachments', async () => {
  const h = await harness()
  const native = new LocalAttachmentStore(h.ctx, { dshHome: h.root })
  const root = join(h.root, 'task-images')
  const images = new TaskImages(root, native, 1000)
  try {
    const legacy = await saveBriefImage(native, png, 'image/png')
    const owned = await images.upload(png, 'image/png')
    expect(await images.collect(new Map(), Date.now())).toBe(0)
    expect(await images.collect(new Map(), Date.now() + 2000)).toBe(1)
    await expect(images.read(owned)).rejects.toThrow('expired or is missing')
    expect(await images.read(legacy)).toMatch(/^data:image\/png;base64,/)
    await expect(images.upload('invalid', 'image/png')).rejects.toThrow()
    await expect(images.upload(png, 'image/svg+xml')).rejects.toThrow()
    await expect(images.upload(Buffer.from('not an image').toString('base64'), 'image/png')).rejects.toThrow()
    await expect(images.read('personal-image:v2:../../outside.png')).rejects.toThrow('Invalid task image reference')
    expect(await readdir(root)).toEqual([])
  } finally { await h.close() }
})
