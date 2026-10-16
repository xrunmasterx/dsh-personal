/** Keyless composition of real workbench reads over isolated deterministic business records. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as Host from '../../src/index.ts'
import * as Tools from '../../src/tools.ts'
import { ArtifactStore } from '../../src/artifacts.ts'
import { planIdSchema, profileIdSchema, runIdSchema } from '../../src/models.ts'
import { buildPersonalProfileContent } from '../../src/profile/rules.ts'
import { aiDraft, config, evidenceSnapshot, runRecord } from '../helpers.ts'

export const inject = ['jobs', 'storageDomain', 'subprocess', 'credentials', 'tools', 'userQuestions', 'commands']

export async function apply(ctx: Context): Promise<void> {
  const options = config(join(process.cwd(), '.dsh', 'personal-workbench'))
  await ctx.plugin(Host, options)
  await ctx.plugin({
    inject: ['personalWorkbench'],
    apply: async (ctx: Context) => {
      const store = ctx.personalWorkbench.runtime.store
      const files = new ArtifactStore(join(options.dataRoot, 'artifacts'), options.maxResultBytes)
      const at = '2026-09-03T00:00:00.000Z'
      for (let index = 1; index <= 3; index++) {
        const run = runRecord()
        run.id = runIdSchema.parse(`00000000-0000-4000-8000-00000000000${index}`)
        run.planId = planIdSchema.parse(`00000000-0000-4000-8000-00000000001${index}`)
        run.confirmedPlanIds = [run.planId]
        run.status = index === 3 ? 'failed' : 'completed'
        run.phase = index === 3 ? 'investigating' : 'finished'
        run.completedCases = index === 3 ? 0 : 1
        run.finishedAt = at
        run.title = index === 3 ? '模型连接失败，诊断已保留' : `固定样本调查 ${index}`
        run.error = index === 3 ? '模型连接失败：fixture connection refused' : null
        if (index === 1) {
          await mkdir(files.directory(run.id), { recursive: true })
          await writeFile(
            join(files.directory(run.id), 'report.md'),
            '# 固定样本调查\n\n已完成事故分析；未证明修复已经交付。\n',
          )
          run.artifacts = [await files.register(run.id, 'report', 'report.md')]
        }
        await store.domain.table('runs').put(run.id, run)
      }
      const evidence = evidenceSnapshot()
      evidence.id = '00000000-0000-4000-8000-000000000030'
      const content = buildPersonalProfileContent(
        { evidenceSnapshot: evidence, previousPublished: null, rejectedClaims: [] },
        aiDraft,
        new Date(at),
      )
      content.claims = content.claims
        .filter(claim => claim.dimension !== 'growth')
        .map(claim => ({ ...claim, reviewStatus: 'confirmed' }))
      const generationId = profileIdSchema.parse('00000000-0000-4000-8000-000000000020')
      const id = profileIdSchema.parse('00000000-0000-4000-8000-000000000021')
      await store.domain.table('evidence').put(evidence.id, evidence)
      await store.domain
        .table('profiles')
        .put(generationId, {
          id: generationId,
          snapshotId: evidence.id,
          status: 'completed',
          revision: 2,
          createdAt: at,
          updatedAt: at,
          error: null,
          content,
        })
      await store.domain.table('publications').put(id, { id, generationId, version: 1, publishedAt: at, content })
      await store.domain
        .table('control')
        .update('current', current => ({ ...current, evidenceId: evidence.id, publishedId: id }))
    },
  })
  await ctx.plugin(Tools)
}
