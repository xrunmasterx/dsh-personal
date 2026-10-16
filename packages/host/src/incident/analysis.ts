/** Personal workbench incident/analysis; business rules migrated from ai-workflow. */

import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  debugCaseInputSchema,
  incidentCaseSchema,
  investigationReportContentSchema,
  validatedInvestigationCaseSchema,
  type DebugCaseInput,
  type EvidenceDossier,
  type IncidentCase,
  type InvestigationCaseBundle,
  type InvestigationDraft,
  type InvestigationReportContent,
} from './schema.ts'

const availableEvidenceStatuses = new Set(['analyzed', 'available_for_analysis', 'available_not_analyzed'])

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function createSyntheticTicketCase(dossier: EvidenceDossier): IncidentCase {
  if (!dossier.ticket) throw new Error('A ticket-only Case requires a TAPD ticket')
  const caseId = `${dossier.scope}:tapd:${dossier.ticket.workspaceId}:${dossier.ticket.objectType}:${dossier.ticket.workItemId}`
  return incidentCaseSchema.parse({
    id: caseId,
    incidentKind: dossier.classification.kind,
    crashSightUrl: null,
    appId: null,
    platformId: null,
    issueId: null,
    reportId: null,
    exceptionName: null,
    exceptionMessage: null,
    exceptionAddress: null,
    crashingProcess: null,
    crashingThread: null,
    actionableFrames: [],
    sourceVersion: {
      buildVersion: null,
      platform: null,
      projectStream: null,
      projectChangelist: null,
      engineBranch: null,
      engineCommit: null,
    },
    environment: {
      commandLine: null,
      rhi: null,
      gpu: null,
      deviceProfile: null,
      perfGearQualityLevel: 'unknown',
      perfGearSource: null,
    },
    evidenceRefs: [],
    missingEvidenceRefs: dossier.missingEvidence.filter(gap => gap.caseId === null).map(gap => gap.id),
  })
}

function hasAnalyzableEvidence(dossier: EvidenceDossier): boolean {
  if (
    dossier.ticket?.descriptionSummary.trim() ||
    dossier.humanContext?.trim() ||
    dossier.symptoms.length > 0 ||
    dossier.reproductionSteps.length > 0
  ) {
    return true
  }

  if (
    dossier.cases.some(
      incidentCase =>
        incidentCase.actionableFrames.length > 0 ||
        Boolean(
          incidentCase.exceptionName ||
            incidentCase.exceptionMessage ||
            incidentCase.exceptionAddress ||
            incidentCase.crashingThread,
        ),
    )
  ) {
    return true
  }

  if (
    dossier.evidenceItems.some(item => availableEvidenceStatuses.has(item.status)) ||
    dossier.binaryArtifacts.some(artifact => artifact.status === 'available_not_analyzed')
  ) {
    return true
  }

  return dossier.provenance.tapdTools.length > 0 && dossier.ticket !== null && dossier.ticket.title !== '证据收集未完成'
}

function isEvidenceForCase(item: EvidenceDossier['evidenceItems'][number], caseId: string): boolean {
  if (item.caseId === caseId) {
    return true
  }

  return item.caseId === null && item.source === 'tapd'
}

/**
 * Separate a dossier into Cases with only their own and shared ticket evidence.
 * @param dossier - collected source evidence and missing-evidence records.
 * @returns independent Case inputs with source references preserved.
 */
export function buildDebugCaseInputs(dossier: EvidenceDossier): DebugCaseInput[] {
  if (!hasAnalyzableEvidence(dossier)) {
    return []
  }

  const cases =
    dossier.cases.length > 0
      ? [...new Map(dossier.cases.map(incidentCase => [incidentCase.id, incidentCase])).values()]
      : dossier.ticket
        ? [createSyntheticTicketCase(dossier)]
        : []

  return cases.map((incidentCase) => {
    const selectedEvidenceFiles = dossier.attachmentArtifacts
      .filter(artifact => artifact.caseId === null || artifact.caseId === incidentCase.id)
      .flatMap(artifact =>
        artifact.textFiles.map(file => ({
          evidenceId: file.evidenceId,
          name: file.name,
          kind: file.kind,
          source: file.source,
          absolutePath: file.absolutePath,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        })),
      )
    const materializedEvidenceIds = new Set(selectedEvidenceFiles.map(file => file.evidenceId))
    const selectedEvidence = dossier.evidenceItems.filter(
      item =>
        isEvidenceForCase(item, incidentCase.id) &&
        availableEvidenceStatuses.has(item.status) &&
        !materializedEvidenceIds.has(item.id),
    )
    const selectedMissingEvidence = dossier.missingEvidence.filter(
      gap => gap.caseId === null || gap.caseId === incidentCase.id,
    )
    const selectedBinaryArtifacts = dossier.binaryArtifacts.filter(
      artifact => artifact.caseId === null || artifact.caseId === incidentCase.id,
    )
    const selectedEvidenceIds = uniqueStrings([
      ...selectedEvidence.map(item => item.id),
      ...selectedEvidenceFiles.map(file => file.evidenceId),
    ])

    return debugCaseInputSchema.parse({
      ticket: dossier.ticket
        ? {
          url: dossier.ticket.url,
          title: dossier.ticket.title,
          descriptionSummary: dossier.ticket.descriptionSummary,
        }
        : null,
      case: {
        ...incidentCase,
        evidenceRefs: selectedEvidenceIds,
        missingEvidenceRefs: uniqueStrings([
          ...incidentCase.missingEvidenceRefs,
          ...selectedMissingEvidence.map(gap => gap.id),
        ]),
      },
      symptoms: dossier.symptoms,
      reproductionSteps: dossier.reproductionSteps,
      evidenceItems: selectedEvidence.map(item => ({
        id: item.id,
        source: item.source,
        kind: item.kind,
        status: item.status,
        locator: item.locator,
        summary: item.summary,
        observedFacts: item.observedFacts,
      })),
      evidenceFiles: selectedEvidenceFiles,
      binaryArtifacts: selectedBinaryArtifacts.map(({ caseId: _caseId, ...artifact }) => artifact),
      missingEvidence: selectedMissingEvidence.map(gap => ({
        id: gap.id,
        description: gap.description,
        reason: gap.reason,
        requestedInput: gap.requestedInput,
      })),
      humanContext: dossier.humanContext,
    })
  })
}

function getEvidenceRefs(investigation: InvestigationDraft): string[] {
  return [
    ...investigation.codeLocations.flatMap(location => location.evidenceRefs),
    ...investigation.fileReviews.map(review => review.evidenceRef),
    ...investigation.causalChain.flatMap(step => step.evidenceRefs),
    ...investigation.hypotheses.flatMap(hypothesis => [
      ...hypothesis.supportingEvidenceRefs,
      ...hypothesis.contradictingEvidenceRefs,
    ]),
  ]
}

/**
 * Keep the conclusion label consistent with supported causal depth.
 * @param investigation - model-produced attribution for one Case.
 * @returns the attribution with a supported conclusion label.
 */
export function normalizeInvestigationConclusion(investigation: InvestigationDraft): InvestigationDraft {
  const conclusionLevel =
    investigation.causalDepth === 'reporting_site'
      ? '范围定位'
      : investigation.causalDepth === 'root_cause' &&
          investigation.confidence >= 0.85 &&
          investigation.rootCauseOwner !== 'unknown'
        ? '高置信根因'
        : '原因候选'

  return investigation.conclusionLevel === conclusionLevel ? investigation : { ...investigation, conclusionLevel }
}

function validateRelativeCodePath(sourceRoot: string, scope: 'project' | 'engine', codePath: string): string | null {
  if (isAbsolute(codePath)) {
    return 'must be relative to its declared source scope'
  }

  const scopeRoot = scope === 'project' ? sourceRoot : join(sourceRoot, 'EngineSource')
  const absolutePath = resolve(scopeRoot, codePath)
  const relativePath = relative(scopeRoot, absolutePath)

  if (
    relativePath === '..' ||
    relativePath.startsWith('..\\') ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath)
  ) {
    return 'escapes its declared source scope'
  }

  if (!existsSync(absolutePath)) {
    return 'does not exist in the current local source snapshot'
  }

  return null
}

/**
 * Check evidence citations, source locations and conclusion consistency for one Case.
 * @param bundle - isolated Case input and attribution result.
 * @param sourceRoot - absolute source tree used for read-only analysis.
 * @returns human-readable evidence and consistency warnings.
 */
export function validateInvestigationCase(bundle: InvestigationCaseBundle, sourceRoot: string): string[] {
  const warnings: string[] = []
  const knownEvidenceIds = new Set(bundle.caseInput.evidenceItems.map(item => item.id))
  for (const evidenceFile of bundle.caseInput.evidenceFiles) {
    knownEvidenceIds.add(evidenceFile.evidenceId)
  }

  if (bundle.investigation.caseId !== bundle.caseInput.case.id) {
    warnings.push(
      `Investigation case ${bundle.investigation.caseId} differs from input case ${bundle.caseInput.case.id}.`,
    )
  }

  for (const evidenceRef of new Set(getEvidenceRefs(bundle.investigation))) {
    if (!knownEvidenceIds.has(evidenceRef)) {
      warnings.push(`Unknown evidence reference in case ${bundle.caseInput.case.id}: ${evidenceRef}`)
    }
  }

  const knownFileIds = new Set(bundle.caseInput.evidenceFiles.map(file => file.evidenceId))
  for (const review of bundle.investigation.fileReviews) {
    if (knownEvidenceIds.has(review.evidenceRef) && !knownFileIds.has(review.evidenceRef)) {
      warnings.push(
        `Evidence file review ${review.evidenceRef} is not a supplied evidence file for case ${bundle.caseInput.case.id}.`,
      )
    }
  }

  for (const location of bundle.investigation.codeLocations) {
    const pathProblem = validateRelativeCodePath(sourceRoot, location.scope, location.path)
    if (pathProblem) {
      warnings.push(`${location.scope} code path "${location.path}" ${pathProblem}.`)
    }
  }

  if (bundle.investigation.incidentKind !== bundle.caseInput.case.incidentKind) {
    warnings.push(
      `Investigation kind ${bundle.investigation.incidentKind} differs from case kind ${bundle.caseInput.case.incidentKind}.`,
    )
  }

  if (!bundle.caseInput.case.sourceVersion.projectChangelist) {
    warnings.push('Project build changelist is unknown; project conclusions use the current P4 snapshot.')
  }
  if (!bundle.caseInput.case.sourceVersion.engineCommit) {
    warnings.push('Engine build commit is unknown; engine conclusions use the current Git snapshot.')
  }

  const expectedRanks = bundle.investigation.hypotheses.map((_, index) => index + 1)
  const actualRanks = bundle.investigation.hypotheses.map(hypothesis => hypothesis.rank)
  if (JSON.stringify(actualRanks) !== JSON.stringify(expectedRanks)) {
    warnings.push('Hypothesis ranks must be unique and ordered from 1 without gaps.')
  }

  const normalizedConclusion = normalizeInvestigationConclusion(bundle.investigation)
  if (normalizedConclusion.conclusionLevel !== bundle.investigation.conclusionLevel) {
    warnings.push(
      `结论等级 ${bundle.investigation.conclusionLevel} 与因果深度 ${bundle.investigation.causalDepth} 不一致，已规范为 ${normalizedConclusion.conclusionLevel}。`,
    )
  }

  return uniqueStrings(warnings)
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>')
}

function markdownList(items: string[], emptyValue = '无'): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : `- ${emptyValue}`
}

function ownerLabel(owner: InvestigationDraft['rootCauseOwner']): string {
  const labels: Record<InvestigationDraft['rootCauseOwner'], string> = {
    project: 'Project',
    engine: 'Engine',
    content_configuration: '内容/配置',
    platform_driver: '平台/驱动',
    third_party: '第三方',
    unknown: '未知',
  }
  return labels[owner]
}

function originLabel(origin: NonNullable<InvestigationDraft['rootCauseAnalysis']>['origin']): string {
  const labels: Record<NonNullable<InvestigationDraft['rootCauseAnalysis']>['origin'], string> = {
    project: 'Project',
    custom_engine: '定制 Engine',
    upstream_ue: 'UE 原生',
    content_configuration: '内容/配置',
    platform_driver: '平台/驱动',
    third_party: '第三方',
    multi_factor: '多因素',
    unknown: '未知',
  }
  return labels[origin]
}

function causalDepthLabel(depth: InvestigationDraft['causalDepth']): string {
  const labels: Record<InvestigationDraft['causalDepth'], string> = {
    reporting_site: '报告点',
    failure_mechanism: '故障机制',
    root_cause_candidate: '根因候选',
    root_cause: '根因',
  }
  return labels[depth]
}

function evidenceStatusTable(bundle: InvestigationCaseBundle): string {
  const { caseInput, investigation } = bundle
  const runtimeLogs = caseInput.evidenceFiles.filter(file => file.kind === 'runtime_log')
  const stackFiles = caseInput.evidenceFiles.filter(file => ['main_stack', 'thread_dump'].includes(file.kind))
  const binaryArtifacts = caseInput.binaryArtifacts
  const hasStack =
    caseInput.case.actionableFrames.length > 0 ||
    caseInput.evidenceItems.some(item => item.kind === 'stack') ||
    stackFiles.length > 0
  const reviewedFileIds = new Set(investigation.fileReviews.map(review => review.evidenceRef))
  const fullRuntimeLogReview =
    runtimeLogs.length > 0 &&
    runtimeLogs.every(file =>
      investigation.fileReviews.some(review => review.evidenceRef === file.evidenceId && review.coverage === 'full'),
    )
  const logStatus =
    runtimeLogs.length > 0
      ? fullRuntimeLogReview
        ? '有（完整审阅）'
        : runtimeLogs.some(file => reviewedFileIds.has(file.evidenceId))
          ? '有（部分审阅）'
          : '有（尚未审阅）'
      : '无'
  const version = caseInput.case.sourceVersion
  const sourceStatus = `Project ${version.projectChangelist ? 'CL known' : 'degraded'} / Engine ${version.engineCommit ? 'commit known' : 'degraded'}`
  const perfGear = caseInput.case.environment.perfGearQualityLevel
  const perfGearSource = caseInput.case.environment.perfGearSource || '未取得运行时记录'

  return `| 证据 | 状态 | 关键内容 |
|---|---|---|
| Stack | ${hasStack ? '有' : '无'} | ${escapeTableCell(caseInput.case.actionableFrames[0]?.symbol || '无可行动栈帧')} |
| Runtime Log | ${logStatus} | ${runtimeLogs.length > 0 ? runtimeLogs.map(file => file.name).join(', ') : '未取得真实运行日志'} |
| 其他文本证据 | ${caseInput.evidenceFiles.length - runtimeLogs.length > 0 ? '有' : '无'} | ${
  caseInput.evidenceFiles
    .filter(file => file.kind !== 'runtime_log')
    .map(file => file.name)
    .join(', ') || '无'
} |
| 二进制证据 | ${binaryArtifacts.length > 0 ? '有（未宣称自动解析）' : '无'} | ${binaryArtifacts.map(artifact => artifact.name).join(', ') || '无'} |
| PerfGear | ${perfGear} | ${escapeTableCell(perfGearSource)} |
| Source version | ${sourceStatus} | Project CL ${version.projectChangelist || 'unknown'} / Engine ${version.engineCommit || 'unknown'} |`
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) {
    return '高'
  }
  if (confidence >= 0.65) {
    return '中高'
  }
  if (confidence >= 0.4) {
    return '中'
  }
  return '低'
}

function renderCaseReport(
  validatedCase: ReturnType<typeof validatedInvestigationCaseSchema.parse>,
  index: number,
): string {
  const { caseInput, investigation, validationWarnings } = validatedCase
  const rootCauseAnalysis = investigation.rootCauseAnalysis
  const identity = [
    caseInput.case.reportId ? `report ${caseInput.case.reportId}` : null,
    caseInput.case.sourceVersion.buildVersion,
  ]
    .filter(Boolean)
    .join(' / ')
  const hypotheses = [...investigation.hypotheses].sort((left, right) => left.rank - right.rank)
  const hypothesisSections = hypotheses
    .map((hypothesis) => {
      const gap =
        hypothesis.contradictingEvidenceRefs.length > 0
          ? hypothesis.contradictingEvidenceRefs.join(', ')
          : `暂无直接反证；当前证据等级：${hypothesis.evidenceLevel}`
      return `#### 候选 ${hypothesis.rank}：${hypothesis.title}

- **为什么：** ${hypothesis.explanation}
- **反证 / 缺口：** ${gap}
- **最小区分检查：** ${hypothesis.verificationSteps.join('；') || '无'}`
    })
    .join('\n\n')
  const causalChain = investigation.causalChain.map(
    (step, chainIndex) =>
      `${chainIndex + 1}. 【${step.evidenceLevel}】${step.statement}${step.evidenceRefs.length > 0 ? `（${step.evidenceRefs.join(', ')}）` : ''}`,
  )
  const changeCandidates =
    rootCauseAnalysis?.changeCandidates.map((candidate) => {
      const identifier = candidate.identifier || '未定位版本'
      return `【${candidate.evidenceLevel}】${identifier}：${candidate.explanation}`
    }) || []
  const primaryHypothesis = hypotheses[0]
  const rootCauseSection = rootCauseAnalysis
    ? `### 根因追溯

**为什么现在：** ${rootCauseAnalysis.whyNow}

**来源判断：** ${originLabel(rootCauseAnalysis.origin)} — ${rootCauseAnalysis.originRationale}

#### 引入变化候选

${markdownList(changeCandidates, '未识别出有证据支撑的引入变化')}

#### 已审阅历史

${markdownList(rootCauseAnalysis.historyReviewed, '没有审阅可用的版本历史')}

#### 为什么此前未被拦截

${rootCauseAnalysis.escapeAnalysis}

#### 经验沉淀

${markdownList(rootCauseAnalysis.preventionLessons, '当前证据不足以形成额外经验')}`
    : `### 根因追溯

当前证据未建立“为什么现在”、来源变化或逃逸机制的证据链；报告不对这些问题作猜测。`
  const fixSection = primaryHypothesis?.fixRecommendation
    ? `### 修复建议

**主候选：${primaryHypothesis.title}**

- 修复方向：${primaryHypothesis.fixRecommendation}
- 风险：${primaryHypothesis.fixRisk || '尚未评估'}
- 验证：${primaryHypothesis.verificationSteps.join('；') || '尚未形成可执行验证'}`
    : ''
  const limitations = uniqueStrings([...investigation.limitations, ...validationWarnings])
  const usedEvidence = new Set(getEvidenceRefs(investigation))
  const evidenceIndex = caseInput.evidenceItems
    .filter(item => usedEvidence.has(item.id))
    .map(item => `[${item.id}] ${item.source}/${item.kind}：${item.summary}`)
  const evidenceFilesById = new Map(caseInput.evidenceFiles.map(file => [file.evidenceId, file]))
  const fileIndex = investigation.fileReviews.map((review) => {
    const file = evidenceFilesById.get(review.evidenceRef)
    const identity = file ? `${file.kind}/${file.name}` : review.evidenceRef
    return `[${review.evidenceRef}] ${identity}；${review.coverage === 'full' ? '完整' : '部分'}；范围：${review.reviewedRanges.join(', ')}；发现：${review.keyFindings.join('；') || '无关键发现'}`
  })
  const sourceIndex = investigation.codeLocations.map((location) => {
    const line = location.line ? `:${location.line}` : ''
    return `[${location.scope}/${location.role}] ${location.path}${line} — ${location.rationale}`
  })

  return `## Case ${index + 1}：${caseInput.case.id}${identity ? `（${identity}）` : ''}

> 结论：${investigation.conclusionLevel}｜因果深度：${causalDepthLabel(investigation.causalDepth)}｜Owner：${ownerLabel(investigation.rootCauseOwner)}｜置信度：${confidenceLabel(investigation.confidence)}

**核心判断：** ${investigation.oneSentenceConclusion}

### 关键理由

${causalChain.join('\n')}

${rootCauseSection}

### 原因候选

${hypothesisSections || '当前证据未形成独立原因候选。'}

${fixSection}

### 下一步

${markdownList(investigation.nextActions, '当前证据下没有更高信息增益动作')}

### 证据与边界

${evidenceStatusTable({ caseInput, investigation })}

### 完整证据审计

**已使用证据**

${markdownList([...evidenceIndex, ...fileIndex, ...sourceIndex])}

**限制**

${markdownList(limitations)}`
}

/**
 * Render the validated Cases and evidence limitations as a Chinese incident report.
 * @param dossier - collected source evidence and missing-evidence records.
 * @param cases - independently validated Case results.
 * @returns the Chinese report and its structured results.
 */
export function renderInvestigationReport(
  dossier: EvidenceDossier,
  cases: Array<ReturnType<typeof validatedInvestigationCaseSchema.parse>>,
): InvestigationReportContent {
  if (cases.length === 0) {
    const requestedInputs = uniqueStrings(
      dossier.missingEvidence.map(gap => gap.requestedInput).filter(Boolean),
    ).slice(0, 3)
    const collectionProblems = uniqueStrings([
      ...dossier.collectionErrors,
      ...dossier.provenance.failedToolCalls.map(call => `${call.server}/${call.tool}：${call.error}`),
    ])
    const markdown = `# ${dossier.ticket?.title || dossier.cases[0]?.exceptionName || 'CrashSight 事故调查'}

> 结论：暂无可分析证据

**核心判断：** 当前没有 Stack、真实运行日志、异常/符号、有效问题描述或版本信息，因此不能诚实地给出原因候选。

## 最小补充需求

${markdownList(requestedInputs, '提供任一项：崩溃 Stack、事故 Log、异常函数名或可定位的问题描述')}

## 收集限制

${markdownList(collectionProblems)}`

    return investigationReportContentSchema.parse({
      status: 'no_evidence',
      incidentKind: dossier.classification.kind,
      title: dossier.ticket?.title || dossier.cases[0]?.exceptionName || 'CrashSight 事故调查',
      markdown,
      dossier,
      cases: [],
    })
  }

  const markdown = `# ${dossier.ticket?.title || dossier.cases[0]?.exceptionName || 'CrashSight 事故调查'}

> 已按 ${cases.length} 个独立 Case 分析；每个 Case 的版本、Stack、命令行和环境互不串用。

${cases.map(renderCaseReport).join('\n\n---\n\n')}`

  return investigationReportContentSchema.parse({
    status: 'completed',
    incidentKind: dossier.classification.kind,
    title: dossier.ticket?.title || dossier.cases[0]?.exceptionName || 'CrashSight 事故调查',
    markdown,
    dossier,
    cases,
  })
}
