import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/artifacts.ts'
import { profileIdSchema } from '../src/models.ts'
import { buildPersonalProfileContent } from '../src/profile/rules.ts'
import { RunBudget, WorkbenchStorage, removeOwnedPath } from '../src/storage.ts'
import { aiDraft, config as makeConfig, evidenceSnapshot, harness, runRecord } from './helpers.ts'

const old = '2000-01-01T00:00:00.000Z'

describe('owned storage retention', () => {
  it('protects publications, reviewed decisions and active work while deleting only the displayed expired set', async () => {
    const h = await harness()
    const config = makeConfig(join(h.root, 'business'))
    await mkdir(config.dataRoot)
    const storage = new WorkbenchStorage(config, h.store)
    try {
      const unused = { ...runRecord(), status: 'completed' as const, updatedAt: old, finishedAt: old }
      const retained = { ...unused, id: runRecord().id }
      const active = runRecord()
      for (const run of [unused, retained, active]) await h.store.domain.table('runs').put(run.id, run)
      const evidence = evidenceSnapshot()
      evidence.createdAt = old
      evidence.evidence[0]!.sourceRunId = retained.id
      const content = buildPersonalProfileContent(
        { evidenceSnapshot: evidence, previousPublished: null, rejectedClaims: [] },
        aiDraft,
        new Date(old),
      )
      content.claims[0]!.reviewStatus = 'confirmed'
      const id = profileIdSchema.parse(randomUUID())
      const draft = {
        id,
        content,
        snapshotId: evidence.id,
        status: 'completed' as const,
        revision: 2,
        createdAt: old,
        updatedAt: old,
        error: null,
      }
      await h.store.domain.table('evidence').put(evidence.id, evidence)
      await h.store.domain.table('profiles').put(id, draft)
      const publication = {
        id: profileIdSchema.parse(randomUUID()),
        generationId: id,
        version: 1,
        publishedAt: old,
        content,
      }
      await h.store.domain.table('publications').put(publication.id, publication)
      const rejected = {
        ...draft,
        id: profileIdSchema.parse(randomUUID()),
        content: {
          ...content,
          claims: content.claims.map(claim => ({ ...claim, reviewStatus: 'rejected' as const })),
        },
      }
      await h.store.domain.table('profiles').put(rejected.id, rejected)
      const directory = join(config.dataRoot, 'artifacts', unused.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'report.md'), 'unused report')
      const orphan = join(config.dataRoot, 'artifacts', randomUUID(), 'fragment.partial')
      await mkdir(join(orphan, '..'), { recursive: true })
      await writeFile(orphan, 'orphan')
      await utimes(orphan, new Date(old), new Date(old))
      const automatic = await storage.preview(false)
      expect(automatic.candidates.map(item => item.id)).toEqual([
        orphan.slice(config.dataRoot.length + 1).replaceAll('\\', '/'),
      ])
      const preview = await storage.preview(true)
      expect(preview.candidates.find(item => item.kind === 'run')?.id).toBe(unused.id)
      expect(
        preview.candidates.some(
          item => item.id === retained.id || item.id === active.id || item.id === rejected.id || item.id === id,
        ),
      ).toBe(false)
      const pubBefore = JSON.stringify(publication)
      await h.store.domain.table('control').update('current', current => ({ ...current, evidenceId: evidence.id }))
      await expect(storage.clean(preview.token, true)).rejects.toThrow(/重新预览/)
      const fresh = await storage.preview(true)
      const result = await h.store.commit(() => storage.clean(fresh.token, true))
      expect(result.removed).toBe(2)
      expect(h.store.domain.table('runs').get(unused.id)).toBeUndefined()
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(orphan, '..'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.stringify(h.store.domain.table('publications').get(publication.id))).toBe(pubBefore)
      expect(h.store.domain.table('profiles').get(rejected.id)).toEqual(rejected)
    } finally {
      await h.close()
    }
  })

  it('restores quarantined artifacts before record deletion and finishes deletion after it committed', async () => {
    const h = await harness()
    const config = makeConfig(join(h.root, 'business'))
    await mkdir(config.dataRoot)
    const storage = new WorkbenchStorage(config, h.store)
    const run = runRecord()
    const original = join(config.dataRoot, 'artifacts', run.id)
    const trash = join(config.dataRoot, '.trash', `artifacts-${run.id}`)
    try {
      await h.store.domain.table('runs').put(run.id, run)
      await mkdir(original, { recursive: true })
      await mkdir(join(config.dataRoot, '.trash'))
      await writeFile(join(original, 'report.md'), 'retained')
      await rename(original, trash)
      await storage.recover()
      expect(await readFile(join(original, 'report.md'), 'utf8')).toBe('retained')
      await rename(original, trash)
      await h.store.domain.table('runs').delete(run.id)
      await storage.recover()
      await expect(stat(trash)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await h.close()
    }
  })

  it('includes expired empty orphan directories even when no files remain to trigger cleanup', async () => {
    const h = await harness()
    const config = makeConfig(join(h.root, 'business'))
    const empty = join(config.dataRoot, 'artifacts', randomUUID())
    const fresh = join(config.dataRoot, 'artifacts', randomUUID())
    try {
      await mkdir(empty, { recursive: true })
      await mkdir(fresh)
      await utimes(empty, new Date(old), new Date(old))
      const storage = new WorkbenchStorage(config, h.store)
      const preview = await storage.preview(false)
      expect(preview.candidates).toHaveLength(1)
      expect(preview.candidates[0]?.bytes).toBe(0)
      await h.store.commit(() => storage.clean(preview.token, false))
      await expect(stat(empty)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(fresh)).isDirectory()).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('rejects linked cleanup targets and reserves active run capacity before admitting records', async () => {
    const h = await harness()
    const root = join(h.root, 'business')
    const outside = join(h.root, 'outside')
    await mkdir(root)
    await mkdir(outside)
    const linked = join(root, 'linked')
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(removeOwnedPath(root, linked)).rejects.toThrow(/outside/)
      expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
      await unlink(linked)
      const config = makeConfig(root)
      config.storage.maxBytes = 2_000_000
      config.storage.maxRunBytes = 1_000_000
      const storage = new WorkbenchStorage(config, h.store)
      await expect(storage.admitRecord(1_000_000, 1)).rejects.toThrow(/额度不足/)
      const budget = new RunBudget(10, 0)
      budget.charge(6)
      expect(() => {
        budget.charge(5)
      }).toThrow(/存储上限/)
    } finally {
      await h.close()
    }
  })

  it('pages verified UTF-8 evidence and rejects content changes or canceled reads', async () => {
    const h = await harness()
    const artifacts = new ArtifactStore(join(h.root, 'artifacts'), 10000)
    const run = runRecord()
    const bytes = Buffer.from('中文证据\n第二行')
    const path = join(artifacts.directory(run.id), 'evidence.txt')
    try {
      await mkdir(artifacts.directory(run.id), { recursive: true })
      await writeFile(path, bytes)
      const file = {
        evidenceId: 'file',
        name: 'evidence.txt',
        absolutePath: path,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const first = await artifacts.preview(run.id, file, 0, 8, new AbortController().signal)
      expect(first.content).toBe('中文')
      const second = await artifacts.preview(run.id, file, first.nextOffset!, 100, new AbortController().signal)
      expect(first.content + second.content).toBe(bytes.toString())
      const migrated = { ...file, absolutePath: `Z:\\Old Home\\personal-workbench\\artifacts\\${run.id}\\evidence.txt` }
      expect((await artifacts.preview(run.id, migrated, 0, 100, new AbortController().signal)).content).toBe(bytes.toString())
      await expect(artifacts.preview(run.id, { ...migrated, absolutePath: migrated.absolutePath.replace('evidence.txt', '..\\outside.txt') }, 0, 100, new AbortController().signal)).rejects.toThrow('outside')
      await expect(artifacts.preview(run.id, { ...migrated, absolutePath: '/unrelated/evidence.txt' }, 0, 100, new AbortController().signal)).rejects.toThrow('outside')
      await expect(artifacts.preview(run.id, file, 0, 8, AbortSignal.abort())).rejects.toMatchObject({
        name: 'AbortError',
      })
      await writeFile(path, Buffer.alloc(bytes.length))
      await expect(artifacts.preview(run.id, file, 0, 8, new AbortController().signal)).rejects.toThrow(/changed/)
    } finally {
      await h.close()
    }
  })
})
