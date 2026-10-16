/** Personal workbench profile/evidence; business rules migrated from ai-workflow. */

import type { GitActivity, GitActivityCommit } from '../git/schema.ts'
import type { TapdTodoItem, TapdTodoSnapshot } from '../tapd/schema.ts'
import { factKey, factVersion } from './facts.ts'
import {
  personalProfileEvidenceSnapshotSchema,
  personalProfileIdentity,
  type PersonalProfileEvidence,
  type PersonalProfileEvidenceSnapshot,
  type PersonalProfileSourceCoverage,
} from './schema.ts'

const dayMs = 24 * 60 * 60 * 1_000

type PersonalProfileInvestigationCase = {
  id: string
  crashSightUrl: string | null
  conclusion: string
  rootCauseOwner: string
  codePaths: string[]
  hypothesisTitles: string[]
}

/**
 * An analysis result used as work evidence, without implying a delivered fix.
 */
export type PersonalProfileInvestigationSource = {
  id: string
  title: string
  occurredAt: string
  tapdUrl: string | null
  incidentKind: string
  cases: PersonalProfileInvestigationCase[]
  legacyProjection?: boolean
}

type PersonalProfileEvidenceSources = {
  readGitActivity(): Promise<GitActivity>
  readTapdSnapshot(): Promise<TapdTodoSnapshot>
  readInvestigations(): Promise<PersonalProfileInvestigationSource[]>
}

function normalizedDate(value: string | undefined, fallback: string): string {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 30): string[] {
  return [...new Set(values.map(value => value?.trim()).filter(Boolean) as string[])].slice(0, limit)
}

function pathTags(paths: string[]): string[] {
  const tags: string[] = []
  for (const path of paths) {
    const normalized = path.replaceAll('\\', '/')
    const extension = normalized.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]
    if (extension === '.cpp' || extension === '.h' || extension === '.hpp') tags.push('C++')
    if (extension === '.usf' || extension === '.ush') tags.push('Unreal Shader')
    for (const topic of ['Renderer', 'Lumen', 'ReflectionCapture', 'SkyLight', 'VolumetricGI', 'RHI', 'D3D12']) {
      if (normalized.toLowerCase().includes(topic.toLowerCase())) tags.push(topic)
    }
  }
  return uniqueStrings(tags)
}

function gitEvidence(commit: GitActivityCommit, collectedAt: string): PersonalProfileEvidence {
  const semantic = commit.semanticCommit
  const filePaths = commit.files.map(file => file.path)
  const fileSummary = filePaths.slice(0, 12).join('、')
  const omitted = Math.max(0, filePaths.length - 12)
  const integration = commit.targetMainStatus === 'reachable' ? '已合入主干' : '提交流程中'
  const body = semantic.body.trim()
  const details = [
    body ? `提交说明：${body.slice(0, 1_500)}` : null,
    `状态：${integration}`,
    `变更：${commit.files.length} 个文件，+${commit.additions} / -${commit.deletions}`,
    fileSummary ? `文件：${fileSummary}${omitted ? ` 等 ${filePaths.length} 个文件` : ''}` : null,
  ]

  return {
    id: `git:${commit.repositoryId}:${commit.sha}`,
    source: 'git',
    kind: 'commit',
    entityId: commit.sha,
    occurredAt: normalizedDate(semantic.authorDate, collectedAt),
    collectedAt,
    title: semantic.subject.trim() || commit.subject.trim() || commit.sha.slice(0, 12),
    summary: uniqueStrings(details, details.length).join('；').slice(0, 4_000),
    tags: uniqueStrings([
      ...pathTags(filePaths),
      integration,
      commit.semanticCommitSource === 'process_history' ? '语义主提交' : null,
    ]),
    url: commit.mainIntegrationCommitUrl ?? commit.carStableCommitUrl ?? null,
  }
}

function tapdUrl(item: TapdTodoItem): string {
  return `https://tapd.woa.com/tapd_fe/${encodeURIComponent(item.workspaceId)}/${item.kind}/detail/${encodeURIComponent(item.id)}`
}

function tapdEvidence(item: TapdTodoItem, collectedAt: string): PersonalProfileEvidence {
  const kindLabel = item.kind === 'bug' ? '缺陷' : item.kind === 'story' ? '故事' : '任务'
  return {
    id: item.key.startsWith('tapd:') ? item.key : `tapd:${item.workspaceId}:${item.kind}:${item.id}`,
    source: 'tapd',
    kind: 'work_item',
    entityId: item.id,
    occurredAt: normalizedDate(item.createdAt, collectedAt),
    collectedAt,
    title: item.title,
    summary: uniqueStrings([
      `类型：${kindLabel}`,
      `状态：${item.status}`,
      item.priority ? `优先级：${item.priority}` : null,
      item.iteration ? `迭代：${item.iteration}` : null,
    ]).join('；'),
    tags: uniqueStrings([kindLabel, item.status, item.priority, item.iteration]),
    url: tapdUrl(item),
  }
}

function investigationEvidence(
  investigation: PersonalProfileInvestigationSource,
  collectedAt: string,
): PersonalProfileEvidence[] {
  return investigation.cases.map((incidentCase) => {
    const codePaths = incidentCase.codePaths.slice(0, 12)
    const hypotheses = incidentCase.hypothesisTitles.slice(0, 4)
    const source = incidentCase.crashSightUrl ? 'crashsight' : 'tapd'
    const fact: PersonalProfileEvidence = {
      id: `${source}:investigation:${incidentCase.id}`,
      source,
      kind: 'investigation',
      entityId: incidentCase.id,
      occurredAt: normalizedDate(investigation.occurredAt, collectedAt),
      collectedAt,
      title: `${investigation.title} · Case ${incidentCase.id}`.slice(0, 500),
      summary: uniqueStrings([
        `结论：${incidentCase.conclusion}`,
        `来源运行：${investigation.id}；调查结论不等于修复已交付。`,
        `根因归属：${incidentCase.rootCauseOwner}`,
        hypotheses.length ? `原因候选：${hypotheses.join('、')}` : null,
        codePaths.length ? `代码位置：${codePaths.join('、')}` : null,
      ])
        .join('；')
        .slice(0, 4_000),
      tags: uniqueStrings([
        investigation.incidentKind,
        incidentCase.rootCauseOwner,
        ...pathTags(incidentCase.codePaths),
      ]),
      url: incidentCase.crashSightUrl || investigation.tapdUrl,
      sourceRunId: investigation.id,
      legacyProjection: investigation.legacyProjection === true,
    }
    return { ...fact, id: `${factKey(fact)}:v${factVersion(fact).slice(0, 20)}` }
  })
}

function unavailableCoverage(source: 'git' | 'tapd' | 'crashsight', cutoffAt: string): PersonalProfileSourceCoverage {
  const labels = { git: 'Git', tapd: 'TAPD', crashsight: '缺陷调查' } as const
  return {
    source,
    status: 'unavailable',
    itemCount: 0,
    cutoffAt,
    windowStart: null,
    limitation: `${labels[source]} 本次读取失败；画像不会把缺失数据解释为能力不足。`,
  }
}

/**
 * Freeze dated work evidence and source coverage without interpreting missing sources as poor ability.
 * @param sources - read-only work-evidence sources.
 * @param options - explicit identity, resource limits and source adapters.
 * @returns the immutable evidence snapshot and coverage limitations.
 */
export async function collectPersonalProfileEvidence(
  sources: PersonalProfileEvidenceSources,
  options: { id: string; maxEvidence: number; clock?: () => Date; identity?: typeof personalProfileIdentity },
): Promise<PersonalProfileEvidenceSnapshot> {
  const identity = options.identity ?? personalProfileIdentity
  const now = (options.clock ?? (() => new Date()))()
  const collectedAt = now.toISOString()
  const recentStart = new Date(now.getTime() - 90 * dayMs).toISOString()
  const focusStart = new Date(now.getTime() - 30 * dayMs).toISOString()
  const [gitResult, tapdResult, investigationResult] = await Promise.allSettled([
    sources.readGitActivity(),
    sources.readTapdSnapshot(),
    sources.readInvestigations(),
  ])

  const evidence: PersonalProfileEvidence[] = [
    {
      id: 'user:identity:role',
      source: 'user',
      kind: 'assertion',
      entityId: 'role',
      occurredAt: collectedAt,
      collectedAt,
      title: identity.role,
      summary: `${identity.displayName} 手动确认的正式定位为 ${identity.role}，项目为 ${identity.projects.join('、')}。`,
      tags: [identity.role, ...identity.projects],
      url: null,
    },
  ]
  const coverage: PersonalProfileSourceCoverage[] = [
    {
      source: 'user',
      status: 'available',
      itemCount: 1,
      cutoffAt: collectedAt,
      windowStart: null,
      limitation: '身份、正式定位与隐私规则来自用户明确确认。',
    },
  ]

  if (gitResult.status === 'fulfilled') {
    evidence.push(...gitResult.value.commits.map(commit => gitEvidence(commit, collectedAt)))
    coverage.push({
      source: 'git',
      status: 'available',
      itemCount: gitResult.value.commits.length,
      cutoffAt: gitResult.value.windowEnd,
      windowStart: gitResult.value.windowStart,
      limitation: (
        '仅使用本地引用可见的最近 90 天提交；不会拉取远端更新，代码行数不用于能力评分。' +
        (gitResult.value.observations ?? [])
          .map(
            source =>
              ` ${source.targetMainRef}@${source.targetMainSha.slice(0, 12)}，最近本地抓取：${source.fetchedAt ?? '未知'}。`,
          )
          .join('')
      ).slice(0, 500),
    })
  } else {
    coverage.push(unavailableCoverage('git', collectedAt))
  }

  if (tapdResult.status === 'fulfilled') {
    evidence.push(...tapdResult.value.items.map(item => tapdEvidence(item, collectedAt)))
    coverage.push({
      source: 'tapd',
      status: 'available',
      itemCount: tapdResult.value.items.length,
      cutoffAt: normalizedDate(tapdResult.value.fetchedAt, collectedAt),
      windowStart: null,
      limitation: '当前仅有待办快照，用于近期关注，不代表历史交付表现。',
    })
  } else {
    coverage.push(unavailableCoverage('tapd', collectedAt))
  }

  if (investigationResult.status === 'fulfilled') {
    const seenCases = new Set<string>()
    const investigations = [...investigationResult.value]
      .filter(item => Date.parse(item.occurredAt) >= Date.parse(recentStart))
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .flatMap(item => investigationEvidence(item, collectedAt))
      .filter((item) => {
        if (seenCases.has(factKey(item))) return false
        seenCases.add(factKey(item))
        return true
      })
    evidence.push(...investigations)
    coverage.push({
      source: 'crashsight',
      status: 'available',
      itemCount: investigations.length,
      cutoffAt: collectedAt,
      windowStart: recentStart,
      limitation: '仅包含平台中主动完成的结构化缺陷调查，不能代表全部 CrashSight 活动。',
    })
  } else {
    coverage.push(unavailableCoverage('crashsight', collectedAt))
  }

  coverage.push({
    source: 'knowledge',
    status: 'not_connected',
    itemCount: 0,
    cutoffAt: collectedAt,
    windowStart: null,
    limitation: '知识库尚未接入，暂时无法判断文档、方案与知识沉淀能力。',
  })

  evidence.sort(
    (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id),
  )

  // Round-robin sources prevent a large Git history from excluding every other source.
  const buckets = [...new Set(evidence.map(item => item.source))].map(source =>
    evidence.filter(item => item.source === source),
  )
  const selected: PersonalProfileEvidence[] = []
  for (
    let index = 0;
    selected.length < options.maxEvidence && buckets.some(bucket => index < bucket.length);
    index++
  ) {
    for (const bucket of buckets) {
      const item = bucket[index]
      if (item && selected.length < options.maxEvidence) selected.push(item)
    }
  }
  for (const item of coverage) {
    const omitted =
      evidence.filter(fact => fact.source === item.source).length -
      selected.filter(fact => fact.source === item.source).length
    if (omitted > 0)
      item.limitation = `${item.limitation ?? ''} 本次按来源轮选最近材料，${omitted} 条未纳入，原始记录保留。`.slice(
        0,
        500,
      )
  }

  return personalProfileEvidenceSnapshotSchema.parse({
    id: options.id,
    identity,
    window: { recentStart, focusStart, end: collectedAt },
    coverage,
    evidence: selected,
    createdAt: collectedAt,
  })
}
