/** Personal workbench incident/dual; business rules migrated from ai-workflow. */

import { z } from 'zod'

import { renderInvestigationReport } from './analysis.ts'
import {
  debugCaseInputSchema,
  evidenceDossierSchema,
  investigationDraftSchema,
  investigationReportContentSchema,
  mechanismInvestigationDraftSchema,
  validatedInvestigationCaseSchema,
  type InvestigationReportContent,
} from './schema.ts'

const mechanismCaseBundleSchema = z.object({
  caseInput: debugCaseInputSchema,
  mechanism: mechanismInvestigationDraftSchema,
})

const multiAgentCaseBundleSchema = mechanismCaseBundleSchema.extend({
  investigation: investigationDraftSchema,
})

const validatedMultiAgentCaseSchema = multiAgentCaseBundleSchema.extend({
  validationWarnings: z.array(z.string().min(1)),
})

function labelMultiAgentReport(markdown: string): string {
  const separatorIndex = markdown.indexOf('\n\n')
  const label = '> 分析架构：双 Agent（机制分析 Agent 1 → 独立归因与综合 Agent 2）'
  if (separatorIndex < 0) {
    return `${markdown}\n\n${label}`
  }
  return `${markdown.slice(0, separatorIndex)}\n\n${label}\n\n${markdown.slice(separatorIndex + 2)}`
}

function renderHandoffSummary(cases: z.infer<typeof validatedMultiAgentCaseSchema>[]): string {
  if (cases.length === 0) {
    return '- 无可分析 Case，因此没有 Agent 交接。'
  }

  return cases
    .map((bundle, index) => {
      const targets = bundle.mechanism.codeLocations
        .filter(location => ['trigger', 'root_cause_candidate'].includes(location.role))
        .map((location) => {
          const line = location.line ? `:${location.line}` : ''
          return `${location.scope}/${location.path}${line}`
        })
      return `### Case ${index + 1}：${bundle.caseInput.case.id}

- **Agent 1 机制结论：** ${bundle.mechanism.oneSentenceConclusion}
- **Agent 1 识别的契约：** ${bundle.mechanism.violatedContract || '未确定'}
- **Agent 1 归因目标：** ${targets.join('；') || '未定位到具体源码目标'}
- **Agent 2 最终结论：** ${bundle.investigation.oneSentenceConclusion}`
    })
    .join('\n\n')
}

/**
 * Render attribution results together with the retained mechanism handoffs.
 * @param dossier - collected source evidence and missing-evidence records.
 * @param cases - independently validated Case results.
 * @returns a Chinese report with both mechanism and attribution records.
 */
export function renderMultiAgentInvestigationReport(
  dossier: z.infer<typeof evidenceDossierSchema>,
  cases: z.infer<typeof validatedMultiAgentCaseSchema>[],
): InvestigationReportContent {
  const validatedCases = cases.map(bundle =>
    validatedInvestigationCaseSchema.parse({
      caseInput: bundle.caseInput,
      investigation: bundle.investigation,
      validationWarnings: bundle.validationWarnings,
    }),
  )
  const report = renderInvestigationReport(dossier, validatedCases)
  return investigationReportContentSchema.parse({
    ...report,
    markdown: `${labelMultiAgentReport(report.markdown)}\n\n---\n\n## 双 Agent 交接摘要\n\n${renderHandoffSummary(cases)}`,
  })
}
