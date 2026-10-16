/** Minimal, explicit projection of historical reports that predate full incident validation. */
import { z } from 'zod'
import type { RunRecord } from '../models.ts'
import type { PersonalProfileInvestigationSource } from './evidence.ts'

const reportSchema = z.object({
  incidentKind: z.string(),
  title: z.string(),
  cases: z
    .array(
      z.object({
        caseInput: z.object({
          case: z.object({
            id: z.string(),
            crashSightUrl: z.url().nullable(),
            appId: z.string().nullable().optional(),
            platformId: z.union([z.string(), z.number().int().nonnegative()]).nullable().optional(),
            reportId: z.string().nullable().optional(),
          }),
        }),
        investigation: z.object({
          oneSentenceConclusion: z.string(),
          rootCauseOwner: z.string(),
          conclusionLevel: z.string().optional(),
          codeLocations: z.array(z.object({ path: z.string(), scope: z.string().optional() })),
          hypotheses: z.array(z.object({ title: z.string() })),
        }),
      }),
    )
    .min(1),
})

/**
 * Recover only fields actually recorded by the old profile workflow.
 * @param run - verified imported run owning this result.
 * @param raw - hash-verified legacy result JSON.
 * @param connectionId - current account namespace.
 * @returns attributable work evidence, or null when the old minimum fields are absent.
 */
export function projectLegacyInvestigation(
  run: RunRecord,
  raw: unknown,
  connectionId: string,
): PersonalProfileInvestigationSource | null {
  const parsed = reportSchema.safeParse(raw)
  if (!parsed.success || !run.finishedAt) return null
  return {
    id: run.id,
    title: parsed.data.title,
    occurredAt: run.finishedAt,
    tapdUrl: run.target.kind === 'tapd' ? run.target.url : null,
    incidentKind: parsed.data.incidentKind,
    legacyProjection: true,
    cases: parsed.data.cases.map(({ caseInput, investigation }) => {
      const item = caseInput.case
      const url = item.crashSightUrl ? new URL(item.crashSightUrl) : null
      const report = url ? /\/crashes\/([^/]+)\/[^/]+\/report-id\/([^/]+)/.exec(url.pathname) : null
      const appId = item.appId ?? report?.[1]
      const platformId = item.platformId ?? url?.searchParams.get('pid')
      const reportId = item.reportId ?? report?.[2]
      return {
        id:
          appId && platformId && reportId
            ? `${connectionId}:crash:${appId}:${platformId}:${reportId}`
            : `${run.sourceKey}:${item.id}`,
        crashSightUrl: item.crashSightUrl,
        conclusion: `${investigation.conclusionLevel ?? '旧版未记录结论等级'}：${investigation.oneSentenceConclusion}`,
        rootCauseOwner: investigation.rootCauseOwner,
        codePaths: investigation.codeLocations.map(location =>
          location.scope ? `${location.scope}/${location.path}` : location.path,
        ),
        hypothesisTitles: investigation.hypotheses.map(hypothesis => hypothesis.title),
      }
    }),
  }
}
