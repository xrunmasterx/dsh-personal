/** Native DSH tools: one shared journal, explicit instructions, confirmed suggestions and cited retrospectives. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { journalWriteSchema, journalReportSchema, type JournalId } from './journal.ts'
import type {} from './index.ts'

/**
 * Register journal consumers on the existing DSH session's tool registry.
 * @param ctx - workbench, tool and official question services.
 */
export function registerJournalTools(ctx: Context): void {
  const service = ctx.personalWorkbench
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'journal_read',
          description:
            'Read the user’s personal work journal across sessions. Work items need no TAPD/CrashSight ticket. Plans are intentions; dated progress and explicit status changes describe actual work. Use local YYYY-MM-DD dates supplied by the user; do not infer exact hours. Follow nextOffset until all relevant pages are read. For weekly reflection read week, activity (including revertedIds), and report; item history provides original plans. Do not count undone progress or current status as historical completion.',
          parameters: {
            kind: {
              type: 'string',
              enum: ['items', 'item', 'activity', 'history', 'week', 'report'],
              required: true,
            },
            from: { type: 'string', description: 'YYYY-MM-DD. For week/report, any date in that week.' },
            to: { type: 'string', description: 'Last date for activity or item filtering.' },
            itemId: { type: 'string', description: 'Required for item or history. Use item to read the complete current description and session summaries before editing.' },
            offset: { type: 'number', description: 'Use nextOffset; starts at zero.' },
            text: { type: 'string', description: 'Optional item search.' },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          presentCall: args => ({ card: 'generic', kind: 'read', title: '读取工作记录', rawInput: args }),
          execute: args =>
            Promise.resolve().then(() => {
              const offset = args.offset ?? 0
              switch (args.kind) {
                case 'item':
                  return JSON.stringify(service.journal.readItem(args.itemId as JournalId))
                case 'week':
                  return JSON.stringify(service.journalWeek(args.from ?? '', offset))
                case 'report':
                  return JSON.stringify(service.journalReport(args.from ?? ''))
                case 'history':
                  return JSON.stringify(service.journalHistory(args.itemId as JournalId, offset))
                case 'activity':
                  return JSON.stringify(service.journalActivity(args.from ?? '', args.to ?? '', offset))
                default:
                  return JSON.stringify(
                    service.journalQuery({
                      from: args.from ?? null,
                      to: args.to ?? null,
                      text: args.text ?? '',
                      offset,
                      includeOpen: true,
                    }),
                  )
              }
            }),
        }),
      ),
    'Native DSH journal reads',
  )
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'journal_write',
          description:
            'Persist a personal work change. Only explicit user instructions use intent=explicit; your scheduling suggestions and bulk rescheduling MUST use intent=suggestion, which asks the user before writing. Do not impose daily work-hour budgets, silently roll unfinished work forward, invent progress, or change TAPD status. Update progress incrementally, distinguish diagnosis from repair, and retain the user’s actual date when backfilling. JSON change fields: operation=create|update|plan|unplan|progress|delete|reorder|undo; itemId (omit for create); expectedRevision (0 for create, otherwise read it first); day=YYYY-MM-DD; reason=the user instruction; optional description (free-form Markdown task brief, organize naturally for the subject; read the latest description and preserve prior facts when extending it), title, status=todo|active|blocked|done|canceled, nextAction, links=[{title,url}], text=original relevant user wording, also supported with update, minutes=explicit actual minutes, plan={day,intention,start:null,end:null}. Use plan with optional replaceDay=original date to atomically move an existing plan; omit replaceDay to add/edit a day. Use unplan to remove only the specified day, retaining its history. Omit minutes when unknown. delete removes an item from the board while retaining history; undo restores the latest change, including deletion. reorder changes only visual order; reorderBefore is the target execution item ID, or null to place last. UUID requestId may be supplied to retry the identical write safely.',
          parameters: {
            intent: { type: 'string', enum: ['explicit', 'suggestion'], required: true },
            taskSummary: { type: 'string', description: 'Required for board/task conversation create/update/progress: cumulative task-specific conversation summary, at most 2000 characters.' },
            change: {
              type: 'string',
              description: 'JSON object following the documented work-change fields.',
              required: true,
            },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          presentCall: args => ({
            card: 'generic',
            kind: 'execute',
            title: '整理工作记录',
            rawInput: args.change,
          }),
          execute: async (args, exec) => {
            const parsed: unknown = JSON.parse(args.change)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('Change must be a JSON object')
            const input = parsed as Record<string, unknown>
            const requestId = input.requestId ?? (exec.agent
              ? callIdentity(`${exec.agent.session.id}:${exec.callId}`) : randomUUID())
            const request = journalWriteSchema.parse({
              ...input,
              requestId,
              itemId: input.itemId ?? (input.operation === 'create' ? requestId : undefined),
            })
            exec.signal.throwIfAborted()
            if (args.intent === 'suggestion') {
              const answer = await ctx.userQuestions.ask({
                ...(exec.agent ? { agent: exec.agent } : {}),
                signal: exec.signal,
                questions: [
                  {
                    id: request.requestId,
                    question: `采纳这项工作安排建议？\n${request.title ?? service.journalHistory(request.itemId, 0).events[0]?.after?.title ?? ''}\n${request.plan ? `${request.replaceDay ? `${request.replaceDay} → ` : ''}${request.plan.day} ${request.plan.intention}` : (request.text ?? request.nextAction ?? '')}\n${request.reason}`,
                    options: [{ label: '采纳' }, { label: '暂不调整' }],
                  },
                ],
              })
              if (
                !answer.answers.some(
                  value => value.id === request.requestId && value.selected.includes('采纳'),
                )
              )
                return '未采纳建议，工作记录未修改。'
            }
            exec.signal.throwIfAborted()
            return JSON.stringify(exec.agent
              ? await service.recordConversationChange(exec.agent.session, request, args.taskSummary ?? '')
              : await service.journalWrite(request))
          },
        }),
      ),
    'Native DSH journal writes',
  )
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'journal_save_reflection',
          description:
            'Save the user’s concise personal weekly reflection after reading ALL week item and activity pages. Summarize actual progress, plan changes and temporary work, remaining work/blockers, and confirmed next-week plans separately from suggestions. Do not invent time, causes or achievements. Read journal_read(report) for expectedReportId and journal_read(week) for the current fingerprint. Cite real event IDs in references and in Markdown links #journal-event-ID so the user can inspect original records. Saving does not change work plans. Do not overwrite an edited report without re-reading it.',
          parameters: {
            from: { type: 'string', required: true, description: 'Monday YYYY-MM-DD returned by week.' },
            fingerprint: { type: 'string', required: true },
            expectedReportId: {
              type: 'string',
              description: 'Current saved report ID; omit if no report exists.',
            },
            markdown: {
              type: 'string',
              required: true,
              description: 'Concise personal retrospective with source links.',
            },
            references: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description: 'Supporting event UUIDs returned by journal reads.',
            },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          presentCall: args => ({
            card: 'generic',
            kind: 'execute',
            title: '保存个人周复盘',
            rawInput: args.from,
          }),
          execute: async args =>
            JSON.stringify(
              await service.journalSaveReport(
                journalReportSchema.parse({
                  ...args,
                  kind: 'generate',
                  id: randomUUID(),
                  expectedReportId: args.expectedReportId ?? null,
                }),
              ),
            ),
        }),
      ),
    'Native DSH personal retrospective',
  )
}

function callIdentity(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
