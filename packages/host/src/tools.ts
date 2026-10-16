/** Chat consumers of the same workbench service used by both boards. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from './index.ts'
import { parseCrashSightReference } from './incident/collector.ts'
import { runIdSchema, type InvestigationTarget } from './models.ts'
import { registerJournalTools } from './journal-tools.ts'

/** Chat surfaces require the business owner and official tool/question/command services. */
export const inject = ['personalWorkbench', 'tools', 'userQuestions', 'commands']

/**
 * Register read and investigation tools plus a human-facing status command.
 * @param ctx - scoped plugin Context; registrations are disposed with this consumer.
 */
export function apply(ctx: Context): void {
  registerJournalTools(ctx)
  const service = ctx.personalWorkbench
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'workbench_code_read',
    description: 'Read archived code changes and observed integration stages for task updates or weekly reports. Read all pages for the requested interval. equivalentTo identifies an identical patch analyzed once; do not count those copies as separate achievements. Stage timestamps record first observation, not exact merge times. Mainline integration proves this change landed, not that the whole task is complete. Reading does not run analysis.',
    parameters: {
      from: { type: 'string', description: 'Inclusive ISO timestamp with timezone; omit for all retained evidence.' },
      to: { type: 'string', description: 'Exclusive ISO timestamp with timezone.' },
      offset: { type: 'number', description: 'Start at zero; continue with nextOffset.' },
      taskId: { type: 'string', description: 'Optional existing task ID.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', kind: 'read', title: '代码进展', rawInput: args }),
    execute: args => Promise.resolve(JSON.stringify(service.codeList(args.from ?? null, args.to ?? null, args.offset ?? 0, args.taskId))),
  })), 'Retained code evidence reads')
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbench_read',
          description:
            'Read personal investigation history, a verified report, or the current human-published profile. Reading never starts a model. A completed investigation does not mean a fix was delivered.',
          parameters: {
            kind: { type: 'string', enum: ['runs', 'report', 'profile'], required: true },
            runId: { type: 'string', description: 'Required only for a report; use an ID from runs.' },
            offset: { type: 'number', description: 'History offset; use nextOffset from the previous page. Starts at zero.' },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          presentCall: args => ({
            card: 'generic',
            kind: 'read',
            title: `个人工作台 · ${args.kind}`,
            rawInput: args.runId,
          }),
          async execute(args) {
            if (args.kind === 'report') return service.readReport(runIdSchema.parse(args.runId))
            if (args.kind === 'profile') return JSON.stringify(service.runtime.profileState().published)
            return JSON.stringify(service.listRuns({ offset: args.offset ?? 0, target: null, text: '', mode: 'all', status: 'all' }))
          },
        }),
      ),
    'Personal workbench reads',
  )
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'workbench_investigate',
          description:
            'Prepare a TAPD defect or exact CrashSight Issue/Report investigation, then ask the human to approve its frozen scope once. Starts a background single/dual investigation only after that answer. For version/time-filtered sample selection use the CrashSight board.',
          parameters: {
            url: {
              type: 'string',
              required: true,
              description: 'Original TAPD defect or CrashSight Issue/Report URL.',
            },
            mode: { type: 'string', enum: ['single', 'dual'], required: true },
            additionalContext: { type: 'string', required: true },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          presentCall: args => ({
            card: 'generic',
            kind: 'execute',
            title: '预览事故调查',
            rawInput: { url: args.url, mode: args.mode },
          }),
          async execute(args, exec) {
            exec.signal.throwIfAborted()
            const reference = parseCrashSightReference(args.url)
            let target: InvestigationTarget
            if (!reference) target = { kind: 'tapd', url: args.url }
            else if (reference.kind === 'report' && reference.appId && reference.reportId && reference.platformId)
              target = {
                kind: 'crash-report',
                report: {
                  appId: reference.appId,
                  platformId: Number(reference.platformId),
                  issueId: reference.issueId,
                  crashHash: reference.reportId,
                  crashId: null,
                  version: null,
                  uploadedAt: null,
                },
              }
            else if (reference.kind === 'issue' && reference.appId && reference.issueId && reference.platformId)
              target = {
                kind: 'crash-issue',
                appId: reference.appId,
                platformId: Number(reference.platformId),
                issueId: reference.issueId,
              }
            else throw new Error('Use a scoped CrashSight Issue or Report URL, or select Reports in the board')
            let samples: import('./models.ts').ReportRef[] = []
            if (target.kind === 'crash-issue') {
              const info = await service.describe()
              const now = Date.now()
              const reports = await service.listReports({ appId: target.appId, platformId: target.platformId,
                from: now - info.queryWindowDays * 86_400_000, to: now, version: '', keyword: '', issueId: target.issueId, status: null, offset: 0 }, target.issueId)
              const first = reports.items[0]
              if (!first) throw new Error('No Report matched the default recent window; select a window in the CrashSight board')
              samples = [first]
            }
            const plan = await service.createPlan({
              target,
              mode: args.mode,
              samples,
              additionalContext: args.additionalContext,
            })
            exec.signal.throwIfAborted()
            const answer = await ctx.userQuestions.ask({
              ...(exec.agent ? { agent: exec.agent } : {}),
              signal: exec.signal,
              questions: [
                {
                  id: plan.id,
                  question: `开始${plan.mode === 'dual' ? '双 Agent' : '单 Agent'}调查「${plan.title}」？源码：${plan.sourceRoot}。固定样本：${plan.samples.map(sample => `${sample.appId}/${sample.platformId}/${sample.crashHash}（${sample.version ?? '版本未知'}）`).join('；') || 'TAPD 描述'}。补充背景：${plan.additionalContext || '无'}。`,
                  options: [{ label: '开始调查' }, { label: '取消' }],
                },
              ],
            })
            exec.signal.throwIfAborted()
            if (!answer.answers.some(value => value.id === plan.id && value.selected.includes('开始调查')))
              return '已取消；没有启动模型。'
            return JSON.stringify(await service.startInvestigation(plan.id))
          },
        }),
      ),
    'Personal workbench investigation',
  )
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'workbench',
        description: '查看个人调查与已发布画像',
        handler: () => {
          const runs = service.runtime.listRuns()
          const active = runs.filter(run => ['queued', 'running', 'stopping'].includes(run.status))
          const published = service.runtime.profileState().published
          return {
            kind: 'success',
            text: `调查记录 ${runs.length} 条，进行中 ${active.length} 条。${published ? `当前画像版本 ${published.version}：${published.content.summary}` : '尚未发布个人画像。'}`,
          }
        },
      }),
    'Personal workbench status command',
  )
}
