import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { expect, it, vi } from 'vitest'
import { harness } from './helpers.ts'

const reads = vi.hoisted(() => ({ active: 0, peak: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (!String(args[0]).includes('native_io_compat')) return actual.readFile(...args)
    reads.active++; reads.peak = Math.max(reads.peak, reads.active)
    try {
      if (reads.active > 16) throw Object.assign(new Error('Fixture file descriptor limit'), { code: 'EMFILE' })
      await new Promise<void>(resolve => setImmediate(resolve))
      return await actual.readFile(...args)
    } finally { reads.active-- }
  } }
})

it('loads every native JSON record within a bounded file descriptor budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-native-json-'))
  const directory = join(root, 'storage/native_io_compat/records')
  await mkdir(directory, { recursive: true })
  for (let i = 0; i < 80; i++) await writeFile(join(directory, `${i}.json`), JSON.stringify({ version: 1, record: { value: i } }))
  const h = await harness(root)
  try {
    const domain = await h.ctx.storageDomain.open(defineDomain({ name: 'native_io_compat', version: 1,
      layout: 'per-record', tables: { records: domainTable<string, { value: number }>(z.object({ value: z.number() })) } }))
    try {
      expect([...domain.table('records').entries()]).toHaveLength(80)
      expect(reads.peak).toBeLessThanOrEqual(16)
    } finally { await domain.close() }
  } finally { await h.close(); await rm(root, { recursive: true, force: true }) }
})
