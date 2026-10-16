/** Deterministic single/dual investigation sequence sharing evidence and report rules. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactStore } from '../artifacts.ts'
import type { WorkbenchBoards } from '../boards.ts'
import type { Config } from '../config.ts'
import type { ModelExecutor } from '../executor.ts'
import type { InvestigationPhase, RunRecord } from '../models.ts'
import type { RunBudget } from '../storage.ts'
import {
  buildDebugCaseInputs,
  normalizeInvestigationConclusion,
  renderInvestigationReport,
  validateInvestigationCase,
} from './analysis.ts'
import { buildAttributionPrompt, buildMechanismPrompt } from './codex-dual.ts'
import { buildInvestigationPrompt } from './codex.ts'
import { createMcpIncidentEvidenceCollector, type CrashSightReference } from './collector.ts'
import { renderMultiAgentInvestigationReport } from './dual.ts'
import { finalizeIncidentPackage } from './evidence-store.ts'
import {
  investigationDraftSchema,
  mechanismInvestigationDraftSchema,
  type EvidenceDossier,
  type InvestigationReportContent,
  type MechanismInvestigationDraft,
} from './schema.ts'

/** Frozen context retained in an admitted plan and copied into the run's input artifact. */
export interface PreparedInvestigation {
  ticket: EvidenceDossier['ticket']
  ticketEvidence: EvidenceDossier['evidenceItems']
}

/**
 * Convert a pinned Report into the collector's exact lookup request.
 * @param report - normalized Report chosen during preview.
 * @returns reference that never resolves an Issue's latest Report during execution.
 */
export function reportReference(report: RunRecord['samples'][number]): CrashSightReference {
  return {
    kind: 'report',
    appId: report.appId,
    platformId: String(report.platformId),
    reportId: report.crashHash,
    issueId: report.issueId,
    shareId: null,
    url: report.issueId
      ? `https://crashsight.qq.com/crash-reporting/crashes/${encodeURIComponent(report.appId)}/${encodeURIComponent(report.issueId)}/report-id/${encodeURIComponent(report.crashHash)}?pid=${report.platformId}`
      : 'https://crashsight.qq.com/',
  }
}

/**
 * Execute one approved run; each model call uses a new thread and isolated Case input.
 * @param input - run, frozen context, owned adapters and progress sink.
 * @returns completed structured report; persistence of the terminal state belongs to the service.
 */
export async function investigate(input: {
  run: RunRecord
  prepared: PreparedInvestigation
  config: Config
  boards: WorkbenchBoards
  artifacts: ArtifactStore
  execute: ModelExecutor
  signal: AbortSignal
  budget: RunBudget
  progress: (phase: InvestigationPhase, completed: number, total: number) => Promise<void>
}): Promise<InvestigationReportContent> {
  const { run, prepared, config, boards, artifacts, execute, signal, progress } = input
  signal.throwIfAborted()
  await progress('collecting', 0, run.samples.length)
  const collector = createMcpIncidentEvidenceCollector({
    evidenceStoreRoot: artifacts.root,
    sessions: boards.sessions(signal),
    connectionId: config.connectionId,
    maxCases: config.maxCases,
    limits: config.evidenceLimits,
    budget: input.budget,
    tapdWorkspaceIds: config.tapdWorkspaceIds,
    crashApps: config.crashApps,
  })
  const dossier = await collector.collectEvidence({
    ...(run.target.kind === 'tapd' ? { tapdUrl: run.target.url } : {}),
    crashReferences: run.samples.map(reportReference),
    ticketSnapshot: prepared.ticket,
    ticketEvidence: prepared.ticketEvidence,
    additionalContext: run.additionalContext,
    materialize: true,
    runId: run.id,
    signal,
  })
  signal.throwIfAborted()
  for (const sample of run.samples) {
    if (
      !dossier.cases.some(
        item =>
          item.appId === sample.appId &&
          Number(item.platformId) === sample.platformId &&
          item.reportId === sample.crashHash,
      )
    )
      throw new Error('An approved Report is no longer readable; prepare a new investigation scope')
  }
  await progress('preparing', 0, dossier.cases.length)
  const cases = buildDebugCaseInputs(dossier)
  const mechanisms = new Map<string, MechanismInvestigationDraft>()
  const completed: InvestigationReportContent['cases'] = []
  const directory = artifacts.directory(run.id)
  const mainStacks = new Map<string, string | null>()
  for (const item of cases) {
    const file = item.evidenceFiles.find(file => file.kind === 'main_stack')
    mainStacks.set(item.case.id, file ? await readFile(file.absolutePath, 'utf8') : null)
  }
  if (run.mode === 'dual') {
    for (const [index, caseInput] of cases.entries()) {
      signal.throwIfAborted()
      await progress('mechanism', index, cases.length)
      const name = `case-${createHash('sha256').update(caseInput.case.id).digest('hex').slice(0, 20)}-mechanism`
      const draft = mechanismInvestigationDraftSchema.parse(
        await execute({
          prompt: buildMechanismPrompt(caseInput, run.sourceRoot, mainStacks.get(caseInput.case.id)),
          schema: mechanismInvestigationDraftSchema,
          directory: join(directory, 'model-inputs'),
          name,
          profile: false,
          budget: input.budget,
          signal,
        }),
      )
      if (draft.caseId !== caseInput.case.id) throw new Error('Mechanism result refers to a different Case')
      mechanisms.set(caseInput.case.id, draft)
    }
  }
  for (const [index, caseInput] of cases.entries()) {
    signal.throwIfAborted()
    await progress(run.mode === 'dual' ? 'attribution' : 'investigating', index, cases.length)
    const mechanism = mechanisms.get(caseInput.case.id)
    if (run.mode === 'dual' && !mechanism) throw new Error('The Case mechanism must complete before attribution')
    const prompt =
      mechanism
        ? buildAttributionPrompt(
          caseInput,
          mechanism,
          run.sourceRoot,
          mainStacks.get(caseInput.case.id),
        )
        : buildInvestigationPrompt(caseInput, run.sourceRoot, mainStacks.get(caseInput.case.id))
    const name = `case-${createHash('sha256').update(caseInput.case.id).digest('hex').slice(0, 20)}-${run.mode}`
    const investigation = investigationDraftSchema.parse(
      await execute({
        prompt,
        schema: investigationDraftSchema,
        directory: join(directory, 'model-inputs'),
        name,
        profile: false,
        budget: input.budget,
        signal,
      }),
    )
    if (investigation.caseId !== caseInput.case.id) throw new Error('Investigation result refers to a different Case')
    await progress('validating', index, cases.length)
    const bundle = { caseInput, investigation }
    completed.push({
      ...bundle,
      investigation: normalizeInvestigationConclusion(investigation),
      validationWarnings: validateInvestigationCase(bundle, run.sourceRoot),
    })
  }
  signal.throwIfAborted()
  await progress('reporting', cases.length, cases.length)
  const report =
    run.mode === 'dual'
      ? renderMultiAgentInvestigationReport(
        dossier,
        completed.map((bundle) => {
          const mechanism = mechanisms.get(bundle.caseInput.case.id)
          if (!mechanism) throw new Error('A completed dual Case must retain its mechanism')
          return { ...bundle, mechanism }
        }),
      )
      : renderInvestigationReport(dossier, completed)
  const finalized = await finalizeIncidentPackage({
    dossier,
    evidenceStoreRoot: artifacts.root,
    workflowRunId: run.id,
    markdown: report.markdown,
    status: report.status,
    budget: input.budget,
  })
  return { ...report, dossier: finalized.dossier, cases: report.cases.map((bundle) => {
    const mechanism = mechanisms.get(bundle.caseInput.case.id)
    return { ...bundle, ...(mechanism ? { mechanism } : {}) }
  }) }
}
