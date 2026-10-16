/** One durable domain and one serialized owner for multi-record business commits. */
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import {
  artifactSchema,
  evidenceSnapshotSchema,
  profileIdSchema,
  profileRecordSchema,
  publicationSchema,
  runRecordSchema,
  tapdCacheSchema,
  type ProfileId,
  type RunId,
} from './models.ts'

const controlSchema = z.object({
  publishedId: profileIdSchema.nullable(),
  evidenceId: z.string().nullable(),
  evidenceCheckedAt: z.string().optional(),
})

/** Authoritative workbench records; rebuilding a list never rewrites these histories. */
export const workbenchDomain = defineDomain({
  name: 'personal_workbench',
  version: 1,
  layout: 'per-record',
  tables: {
    runs: domainTable<RunId, z.infer<typeof runRecordSchema>>(runRecordSchema),
    profiles: domainTable<ProfileId, z.infer<typeof profileRecordSchema>>(profileRecordSchema),
    publications: domainTable<ProfileId, z.infer<typeof publicationSchema>>(publicationSchema),
    evidence: domainTable<string, z.infer<typeof evidenceSnapshotSchema>>(evidenceSnapshotSchema),
    control: domainTable<'current', z.infer<typeof controlSchema>>(controlSchema),
    tapd: domainTable<'current', z.infer<typeof tapdCacheSchema>>(tapdCacheSchema),
    imported: domainTable<string, { manifest: z.infer<typeof artifactSchema>[]; importedAt: string }>(
      z.object({ manifest: z.array(artifactSchema), importedAt: z.string() }),
    ),
  },
})

/** The Host is the sole owner of this handle and closes it after execution stops. */
export class WorkbenchStore {
  private queue: Promise<void> = Promise.resolve()
  private closing = false

  private readonly epoch = randomUUID()
  private readonly revisions: Record<string, number> = {}
  private readonly detach: () => void
  private readonly fingerprints = new Map<string, string>()

  private constructor(
    readonly domain: Domain<typeof workbenchDomain>,
    ctx: Context,
  ) {
    this.detach = ctx.on('domain/changed', (change) => {
      if (change.domain !== workbenchDomain.name) return
      if (change.operation === 'put' && (change.table === 'runs' || change.table === 'profiles')) {
        const { activity: _activity, updatedAt: _updatedAt, ...record } = change.value as Record<string, unknown>
        const key = `${change.table}:${change.key}`
        const fingerprint = createHash('sha256').update(JSON.stringify(record)).digest('hex')
        if (this.fingerprints.get(key) === fingerprint) return
        this.fingerprints.set(key, fingerprint)
      }
      if (change.operation === 'deleted') this.fingerprints.delete(`${change.table}:${change.key}`)
      this.revisions[change.table] = (this.revisions[change.table] ?? 0) + 1
    })
  }

  /**
   * Return small change tokens without serializing historical content.
   * @returns process epoch and per-table write counters.
   */
  revision(): Record<string, string> {
    return Object.fromEntries(
      Object.keys(workbenchDomain.tables).map(table => [table, `${this.epoch}:${this.revisions[table] ?? 0}`]),
    )
  }

  /**
   * Account for authoritative record content alongside owned artifact files.
   * @returns serialized logical record bytes, excluding filesystem allocation overhead.
   */
  bytes(): number {
    return Object.keys(workbenchDomain.tables).reduce(
      (sum, table) =>
        sum +
        [...this.domain.table(table as keyof typeof workbenchDomain.tables).entries()].reduce(
          (total, [, value]) => total + Buffer.byteLength(JSON.stringify(value)),
          0,
        ),
      0,
    )
  }

  /**
   * Open and initialize this domain under the configured storage backend.
   * @param ctx - Host Context carrying storageDomain.
   * @returns initialized store owned by one workbench service.
   */
  static async open(ctx: Context): Promise<WorkbenchStore> {
    const domain = await ctx.storageDomain.open(workbenchDomain)
    try {
      if (!domain.table('control').get('current'))
        await domain.table('control').put('current', { publishedId: null, evidenceId: null })
      if (!domain.table('tapd').get('current'))
        await domain.table('tapd').put('current', { snapshot: null, lastError: null, lastAttemptAt: null })
      return new WorkbenchStore(domain, ctx)
    } catch (error) {
      await domain.close()
      throw error
    }
  }

  /**
   * Serialize decisions that inspect one table and commit another; reads remain available.
   * @param operation - business-owned commit sequence, publishing its final pointer last.
   * @returns the result after all writes in this sequence settle.
   */
  commit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('The personal workbench is closing'))
    const result = this.queue.then(operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Mark abandoned executions as interrupted without scheduling another model request. */
  async recover(): Promise<void> {
    const now = new Date().toISOString()
    for (const [id, run] of this.domain.table('runs').entries()) {
      if (['queued', 'running', 'stopping'].includes(run.status)) {
        await this.domain
          .table('runs')
          .update(id, current => ({ ...current, status: 'interrupted', updatedAt: now, finishedAt: now }))
      }
    }
    for (const [id, profile] of this.domain.table('profiles').entries()) {
      if (profile.status === 'running' || profile.status === 'stopping')
        await this.domain
          .table('profiles')
          .update(id, current => ({ ...current, status: 'interrupted', updatedAt: now }))
    }
  }

  /** Drain admitted commits before releasing the durable handle. */
  async close(): Promise<void> {
    this.closing = true
    await this.queue
    this.detach()
    await this.domain.close()
  }
}
