/** Plugin-owned context and auxiliary-model audit, independent of DSH's core event list. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { JournalId } from './journal.ts'

const bindingSchema = z.object({ taskId: z.uuid().optional(), week: z.iso.date().optional() })
const recordsDomain = defineDomain({ name: 'personal_plugin_records', version: 1, layout: 'per-record', tables: {
  bindings: domainTable<string, z.infer<typeof bindingSchema>>(bindingSchema),
  audit: domainTable<string, { sessionId: string; type: string; data: unknown; at: string }>(
    z.object({ sessionId: z.string(), type: z.string(), data: z.unknown(), at: z.iso.datetime() })),
} })

declare module '@deepseek-ai/cordis' { interface Context { personalRecords: PersonalRecords } }

/** One owner for durable Personal metadata; native model history stays with DSH. */
export class PersonalRecords extends Service {
  private constructor(ctx: Context, private readonly domain: Domain<typeof recordsDomain>) { super(ctx, 'personalRecords') }

  /** Open plugin-owned records and register their service.
   * @param ctx Host storage owner.
   * @returns Records requiring awaited close after consumers stop.
   */
  static async open(ctx: Context): Promise<PersonalRecords> { return new PersonalRecords(ctx, await ctx.storageDomain.open(recordsDomain)) }

  /** Read the saved conversation scope.
   * @param id Native session identity.
   * @returns Scope, if explicitly prepared.
   */
  binding(id: string): { taskId?: JournalId; week?: string } | undefined {
    return this.domain.table('bindings').get(id) as { taskId?: JournalId; week?: string } | undefined
  }

  /** Persist a conversation scope before exposing it to a model.
   * @param id Native session identity.
   * @param value User-selected task or week.
   * @returns Completion after durable storage.
   */
  async bind(id: string, value: { taskId?: JournalId; week?: string }): Promise<void> { await this.domain.table('bindings').put(id, value) }

  /** Persist an auxiliary request or result without extending core Session vocabulary.
   * @param sessionId Native source identity.
   * @param type Personal audit event name.
   * @param data Exact JSON model input or validated output.
   * @returns Durable audit identity.
   */
  async audit(sessionId: string, type: string, data: unknown): Promise<string> {
    const id = randomUUID()
    await this.domain.table('audit').put(id, { sessionId, type, data, at: new Date().toISOString() })
    return id
  }

  /** Release storage after model and context consumers stop. */
  async close(): Promise<void> { await this.domain.close() }
}
