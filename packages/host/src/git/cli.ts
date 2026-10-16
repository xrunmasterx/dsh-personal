/** Local Git fact extraction migrated from ai-workflow; execution belongs to DSH. */
import assert from 'node:assert/strict'
import {
  GIT_CAR_STABLE_REF,
  gitCommitFactSchema,
  gitFinalCommitFactSchema,
  gitProcessCommitFactSchema,
  type GitCommitFact,
  type GitFinalCommitFact,
  type GitProcessRelation,
} from './schema.ts'

const HEADER_SEPARATOR = '\u001c'
const RECORD_SEPARATOR = '\u001e'
const FIELD_SEPARATOR = '\u001f'

type GitCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type GitCommandExecutor = (repositoryPath: string, args: string[]) => Promise<GitCommandResult>

class GitCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCliError'
  }
}

type GitRepositoryInspection = {
  topLevel: string
  currentBranch: string | null
  headSha: string
  targetMainRef: string | null
  targetMainSha: string | null
  targetMainAuthorDate: string | null
  carStableRef: typeof GIT_CAR_STABLE_REF
  carStableSha: string | null
  repositoryWebUrl: string | null
}

interface GitCli {
  inspectRepository(repositoryPath: string, configuredTargetMainRef?: string | null): Promise<GitRepositoryInspection>
  readFinalCommits(input: {
    repositoryId: string
    repositoryPath: string
    currentBranch: string | null
    targetMainRef: string
    targetMainSha: string
    carStableRef: typeof GIT_CAR_STABLE_REF
    carStableSha: string
    authorEmails: string[]
    windowStart: Date
    windowEnd: Date
    collectedAt: Date
  }): Promise<GitFinalCommitFact[]>
}

function exactSubmissionShas(commit: GitFinalCommitFact): Set<string> {
  return new Set([commit.sha, ...commit.processCommits.map(item => item.sha)])
}

function originalProcessShas(commit: GitFinalCommitFact): Set<string> {
  const processShas = commit.processCommits
    .filter(item => item.relation !== 'cherry_pick_source')
    .map(item => item.sha)
  return new Set(processShas.length ? processShas : [commit.sha])
}

function isCoveredBy(shas: Set<string>, coverage: Set<string>): boolean {
  return [...shas].every(sha => coverage.has(sha))
}

function escapeGitRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function required(result: GitCommandResult, message: string): string {
  if (result.exitCode !== 0) {
    throw new GitCliError(message)
  }
  return result.stdout.trim()
}

function optional(result: GitCommandResult): string | null {
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

function safeRepositoryWebUrl(remoteOriginUrl: string | null): string | null {
  if (!remoteOriginUrl) return null
  try {
    const url = new URL(remoteOriginUrl)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!path || path === '/') return null
    return `${url.origin}${path}`
  } catch {
    return null
  }
}

function parseFiles(lines: string[]): {
  files: GitCommitFact['files']
  additions: number
  deletions: number
} {
  const files: GitCommitFact['files'] = []
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (!line.trim()) continue
    const firstTab = line.indexOf('\t')
    const secondTab = firstTab >= 0 ? line.indexOf('\t', firstTab + 1) : -1
    if (firstTab < 0 || secondTab < 0) continue
    const addedText = line.slice(0, firstTab)
    const deletedText = line.slice(firstTab + 1, secondTab)
    const path = line.slice(secondTab + 1)
    if (!path) continue
    const fileAdditions = /^\d+$/.test(addedText) ? Number(addedText) : null
    const fileDeletions = /^\d+$/.test(deletedText) ? Number(deletedText) : null
    additions += fileAdditions ?? 0
    deletions += fileDeletions ?? 0
    files.push({ path, additions: fileAdditions, deletions: fileDeletions })
  }
  return { files, additions, deletions }
}

function parseLog(input: {
  repositoryId: string
  output: string
  collectedAt: Date
  targetMainStatus?: GitCommitFact['targetMainStatus']
  filter?: {
    authorEmails: string[]
    windowStart: Date
    windowEnd: Date
    dateField: 'author' | 'committer'
  }
}): GitCommitFact[] {
  const allowedEmails = input.filter ? new Set(input.filter.authorEmails.map(email => email.toLowerCase())) : null
  const commits: GitCommitFact[] = []
  for (const record of input.output.split(RECORD_SEPARATOR).slice(1)) {
    const normalized = record.replace(/^\r?\n/, '')
    const headerEnd = normalized.indexOf(HEADER_SEPARATOR)
    if (headerEnd < 0) continue
    const header = normalized.slice(0, headerEnd)
    const stats = normalized
      .slice(headerEnd + HEADER_SEPARATOR.length)
      .replace(/^\r?\n/, '')
      .split(/\r?\n/)
    const fields = header.split(FIELD_SEPARATOR)
    if (fields.length !== 12) continue
    const [
      sha,
      parentsText,
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      committerDate,
      subject,
      _discoveredViaRefText,
      _directRefsText,
      body,
    ] = fields as [string, string, string, string, string, string, string, string, string, string, string, string]
    if (input.filter && allowedEmails) {
      const selectedDate = input.filter.dateField === 'author' ? authorDate : committerDate
      const selectedTime = new Date(selectedDate).getTime()
      if (
        !allowedEmails.has(authorEmail.toLowerCase()) ||
        !Number.isFinite(selectedTime) ||
        selectedTime < input.filter.windowStart.getTime() ||
        selectedTime > input.filter.windowEnd.getTime()
      ) {
        continue
      }
    }
    const fileStats = parseFiles(stats)
    commits.push(
      gitCommitFactSchema.parse({
        repositoryId: input.repositoryId,
        sha,
        parents: parentsText ? parentsText.split(' ') : [],
        subject,
        body: body.replace(/\r\n/g, '\n').trimEnd(),
        authorName,
        authorEmail: authorEmail.toLowerCase(),
        authorDate,
        committerName,
        committerEmail: committerEmail.toLowerCase(),
        committerDate,
        files: fileStats.files,
        additions: fileStats.additions,
        deletions: fileStats.deletions,
        discoveredViaRef: null,
        directRefs: [],
        targetMainStatus: input.targetMainStatus ?? 'unknown',
        collectedAt: input.collectedAt.toISOString(),
      }),
    )
  }
  return commits
}

function logFormat(): string {
  return `${RECORD_SEPARATOR}%H${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%ae${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%cn${FIELD_SEPARATOR}%ce${FIELD_SEPARATOR}%cI${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}${FIELD_SEPARATOR}${FIELD_SEPARATOR}%b${HEADER_SEPARATOR}`
}

function cherryPickSource(body: string): string | null {
  return /^\(cherry picked from commit ([a-f0-9]{7,64})\)\s*$/im.exec(body)?.[1]?.toLowerCase() ?? null
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  const remaining = values.entries()
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (const [index, value] of remaining) {
      results[index] = await operation(value)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Bind semantic Git reads to the caller-owned process runner.
 * @param execute - caller-owned read-only Git command executor.
 * @returns read-only Git operations bound to the supplied runner.
 */
export function createGitCliFromExecutor(execute: GitCommandExecutor): GitCli {
  async function resolveCommit(repositoryPath: string, ref: string): Promise<string | null> {
    return optional(
      await execute(repositoryPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]),
    )
  }

  async function readProcessHistory(input: {
    repositoryId: string
    repositoryPath: string
    finalCommit: GitCommitFact
    collectedAt: Date
  }): Promise<Pick<GitFinalCommitFact, 'sourceCommitRef' | 'processDiscovery' | 'processCommits'>> {
    const processLogArgs = (revisions: string[], noWalk = false) => [
      'log',
      ...(noWalk ? ['--no-walk'] : ['--reverse', '--topo-order']),
      '--no-renames',
      '--diff-merges=first-parent',
      '--no-show-signature',
      `--format=${logFormat()}`,
      '--numstat',
      ...revisions,
    ]
    const sourceRef = cherryPickSource(input.finalCommit.body)
    if (sourceRef) {
      let result = await execute(input.repositoryPath, processLogArgs([sourceRef, `^${sourceRef}^1`]))
      if (result.exitCode !== 0) {
        result = await execute(input.repositoryPath, processLogArgs([sourceRef], true))
      }
      if (result.exitCode !== 0) {
        return {
          sourceCommitRef: sourceRef,
          processDiscovery: 'source_unavailable',
          processCommits: [],
        }
      }
      const commits = parseLog({
        repositoryId: input.repositoryId,
        output: result.stdout,
        collectedAt: input.collectedAt,
      })
      const sourceCommit = commits.find(commit => commit.sha.startsWith(sourceRef))
      if (!sourceCommit) {
        return {
          sourceCommitRef: sourceRef,
          processDiscovery: 'source_unavailable',
          processCommits: [],
        }
      }
      return {
        sourceCommitRef: sourceCommit.sha,
        processDiscovery: 'exact_cherry_pick',
        processCommits: commits.map(commit =>
          gitProcessCommitFactSchema.parse({
            ...commit,
            relation: commit.sha === sourceCommit.sha ? 'cherry_pick_source' : 'source_history',
          }),
        ),
      }
    }

    const mergeParent = input.finalCommit.parents[1]
    if (mergeParent) {
      const result = await execute(
        input.repositoryPath,
        processLogArgs([input.finalCommit.sha, `^${input.finalCommit.parents[0]}`]),
      )
      const output = required(result, 'Git could not read the process history introduced by a final merge commit.')
      const commits = parseLog({
        repositoryId: input.repositoryId,
        output,
        collectedAt: input.collectedAt,
      })
      return {
        sourceCommitRef: mergeParent,
        processDiscovery: 'merge_parents',
        processCommits: commits
          .filter(commit => commit.sha !== input.finalCommit.sha)
          .map(commit =>
            gitProcessCommitFactSchema.parse({
              ...commit,
              relation: 'merged_history' satisfies GitProcessRelation,
            }),
          ),
      }
    }

    return {
      sourceCommitRef: null,
      processDiscovery: 'none',
      processCommits: [],
    }
  }

  async function readActiveBranchSubmissions(
    input: Parameters<GitCli['readFinalCommits']>[0],
  ): Promise<GitFinalCommitFact[]> {
    if (!input.currentBranch) return []

    const remoteBranchRef = `origin/${input.currentBranch}`
    if (remoteBranchRef === input.carStableRef) return []

    const remoteBranchSha = await resolveCommit(input.repositoryPath, remoteBranchRef)
    if (!remoteBranchSha || remoteBranchSha === input.carStableSha || remoteBranchSha === input.targetMainSha) {
      return []
    }

    const output = required(
      await execute(input.repositoryPath, [
        'log',
        '--reverse',
        '--topo-order',
        '--cherry-pick',
        '--right-only',
        '--no-merges',
        '--no-renames',
        '--no-show-signature',
        `--format=${logFormat()}`,
        '--numstat',
        `${input.carStableSha}...${remoteBranchSha}`,
      ]),
      'Git log failed while collecting pushed current-branch submissions.',
    )
    const commits = parseLog({
      repositoryId: input.repositoryId,
      output,
      collectedAt: input.collectedAt,
      filter: {
        authorEmails: input.authorEmails,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        dateField: 'committer',
      },
    }).map(commit => ({ ...commit, discoveredViaRef: remoteBranchRef }))
    const groups: GitCommitFact[][] = []
    for (const commit of commits) {
      const group = groups.at(-1)
      if (group && group.at(-1)?.sha === commit.parents[0]) {
        group.push(commit)
      } else {
        groups.push([commit])
      }
    }

    return await Promise.all(
      groups.map(async (group) => {
        const firstCommit = group[0]
        const finalCommit = group.at(-1)
        assert(firstCommit && finalCommit, 'Each accumulated Git group contains at least one commit')
        let aggregate = {
          files: finalCommit.files,
          additions: finalCommit.additions,
          deletions: finalCommit.deletions,
        }
        if (group.length > 1 && firstCommit.parents[0]) {
          const diffOutput = required(
            await execute(input.repositoryPath, [
              'diff',
              '--no-renames',
              '--numstat',
              firstCommit.parents[0],
              finalCommit.sha,
            ]),
            'Git diff failed while aggregating an active branch submission.',
          )
          aggregate = parseFiles(diffOutput.split(/\r?\n/))
        }

        return gitFinalCommitFactSchema.parse({
          ...finalCommit,
          ...aggregate,
          targetMainStatus: 'not_reachable',
          sourceCommitRef: firstCommit.sha,
          processDiscovery: 'active_branch',
          processCommits: group.slice(0, -1).map(commit =>
            gitProcessCommitFactSchema.parse({
              ...commit,
              relation: 'source_history' satisfies GitProcessRelation,
            }),
          ),
          mainIntegration: null,
        })
      }),
    )
  }

  return {
    async inspectRepository(repositoryPath, configuredTargetMainRef) {
      const topLevel = required(
        await execute(repositoryPath, ['rev-parse', '--show-toplevel']),
        'The configured path is not a readable Git repository.',
      )
      const currentBranch = optional(await execute(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']))
      const headSha = required(
        await execute(repositoryPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
        'The Git repository does not have a readable HEAD commit.',
      )
      const repositoryWebUrl = safeRepositoryWebUrl(
        optional(await execute(repositoryPath, ['config', '--get', 'remote.origin.url'])),
      )

      let targetMainRef = configuredTargetMainRef?.trim() || null
      let targetMainSha = targetMainRef ? await resolveCommit(repositoryPath, targetMainRef) : null
      if (!targetMainRef) {
        const originHead = optional(
          await execute(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
        )
        const candidates = [originHead, 'origin/main', 'origin/master', 'main', 'master'].filter(
          (candidate): candidate is string => Boolean(candidate),
        )
        for (const candidate of candidates) {
          const sha = await resolveCommit(repositoryPath, candidate)
          if (sha) {
            targetMainRef = candidate
            targetMainSha = sha
            break
          }
        }
      }

      const targetMainAuthorDate = targetMainSha
        ? optional(await execute(repositoryPath, ['show', '--no-patch', '--format=%aI', targetMainSha]))
        : null
      const carStableSha = await resolveCommit(repositoryPath, GIT_CAR_STABLE_REF)
      return {
        topLevel,
        currentBranch,
        headSha,
        targetMainRef,
        targetMainSha,
        targetMainAuthorDate,
        carStableRef: GIT_CAR_STABLE_REF,
        carStableSha,
        repositoryWebUrl,
      }
    },

    async readFinalCommits(input) {
      const authorArgs = input.authorEmails.flatMap(email => [`--author=<${escapeGitRegex(email)}>`])
      const output = required(
        await execute(input.repositoryPath, [
          'log',
          '--no-renames',
          '--diff-merges=first-parent',
          '--no-show-signature',
          `--since=${input.windowStart.toISOString()}`,
          `--until=${input.windowEnd.toISOString()}`,
          '--regexp-ignore-case',
          ...authorArgs,
          `--format=${logFormat()}`,
          '--numstat',
          input.carStableSha,
        ]),
        'Git log failed while collecting submissions from the fixed car_stable ref.',
      )
      const mainOutput = required(
        await execute(input.repositoryPath, [
          'log',
          '--first-parent',
          '--reverse',
          '--no-renames',
          '--diff-merges=first-parent',
          '--no-show-signature',
          `--since=${input.windowStart.toISOString()}`,
          `--until=${input.windowEnd.toISOString()}`,
          `--format=${logFormat()}`,
          '--numstat',
          input.targetMainSha,
        ]),
        'Git log failed while matching car_stable submissions to target-main integrations.',
      )
      const mainCommits = parseLog({
        repositoryId: input.repositoryId,
        output: mainOutput,
        collectedAt: input.collectedAt,
      })
      const mainCoverage = new Map<string, { sha: string; committerDate: string }>()
      for (const mainCommit of mainCommits) {
        const integration = {
          sha: mainCommit.sha,
          committerDate: mainCommit.committerDate,
        }
        if (!mainCoverage.has(mainCommit.sha)) {
          mainCoverage.set(mainCommit.sha, integration)
        }
        for (const mergedParent of mainCommit.parents.slice(1)) {
          if (!mainCoverage.has(mergedParent)) {
            mainCoverage.set(mergedParent, integration)
          }
        }
      }
      const finalCommits = parseLog({
        repositoryId: input.repositoryId,
        output,
        collectedAt: input.collectedAt,
        filter: {
          authorEmails: input.authorEmails,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          dateField: 'committer',
        },
      }).map(commit => ({
        ...commit,
        discoveredViaRef: input.carStableRef,
      }))
      const processHistories = await mapWithConcurrency(finalCommits, 4, finalCommit =>
        readProcessHistory({
          repositoryId: input.repositoryId,
          repositoryPath: input.repositoryPath,
          finalCommit,
          collectedAt: input.collectedAt,
        }),
      )
      const carStableShaSet = new Set(finalCommits.map(commit => commit.sha))
      const allowedAuthorEmails = new Set(input.authorEmails.map(email => email.toLowerCase()))
      const directMainCandidates = mainCommits.filter(
        commit =>
          allowedAuthorEmails.has(commit.authorEmail.toLowerCase()) &&
          !carStableShaSet.has(commit.sha) &&
          !commit.parents.slice(1).some(parent => carStableShaSet.has(parent)),
      )
      const directMainHistories = await mapWithConcurrency(directMainCandidates, 4, finalCommit =>
        readProcessHistory({
          repositoryId: input.repositoryId,
          repositoryPath: input.repositoryPath,
          finalCommit,
          collectedAt: input.collectedAt,
        }),
      )
      const directMainCommits = directMainCandidates.map((commit, index) =>
        gitFinalCommitFactSchema.parse({
          ...commit,
          ...directMainHistories[index],
          discoveredViaRef: input.targetMainRef,
          targetMainStatus: 'reachable',
          mainIntegration: {
            sha: commit.sha,
            committerDate: commit.committerDate,
          },
        }),
      )
      for (const mainCommit of directMainCommits) {
        const integration = {
          sha: mainCommit.sha,
          committerDate: mainCommit.committerDate,
        }
        for (const sha of exactSubmissionShas(mainCommit)) {
          if (!mainCoverage.has(sha)) mainCoverage.set(sha, integration)
        }
      }

      const usedMainIntegrationShas = new Set<string>()
      const carStableCommits = finalCommits.map((commit, index) => {
        const process = processHistories[index]
        const stagedCommit = gitFinalCommitFactSchema.parse({
          ...commit,
          ...process,
          targetMainStatus: 'not_reachable',
          mainIntegration: null,
        })
        const exactIntegration = mainCoverage.get(commit.sha) ?? null
        let processIntegration: { sha: string; committerDate: string } | null = null
        for (const sha of originalProcessShas(stagedCommit)) {
          const integration = mainCoverage.get(sha)
          if (!integration) {
            processIntegration = null
            break
          }
          if (
            !processIntegration ||
            new Date(integration.committerDate).getTime() > new Date(processIntegration.committerDate).getTime()
          ) {
            processIntegration = integration
          }
        }
        const mainIntegration = exactIntegration ?? processIntegration
        if (mainIntegration) usedMainIntegrationShas.add(mainIntegration.sha)
        return gitFinalCommitFactSchema.parse({
          ...stagedCommit,
          targetMainStatus: mainIntegration ? 'reachable' : 'not_reachable',
          mainIntegration,
        })
      })
      const completedStableProcessShas = new Set(
        carStableCommits
          .filter(commit => commit.targetMainStatus === 'reachable')
          .flatMap(commit => [...originalProcessShas(commit)]),
      )
      const unmatchedDirectMainCommits = directMainCommits.filter(
        commit =>
          !usedMainIntegrationShas.has(commit.sha) &&
          !isCoveredBy(originalProcessShas(commit), completedStableProcessShas),
      )
      const activeBranchSubmissions = await readActiveBranchSubmissions(input)
      const higherStageCoverage = new Set(
        [...carStableCommits, ...unmatchedDirectMainCommits].flatMap(commit => [...exactSubmissionShas(commit)]),
      )
      const unmatchedActiveBranchSubmissions = activeBranchSubmissions.filter(
        commit => !isCoveredBy(exactSubmissionShas(commit), higherStageCoverage),
      )
      return [...carStableCommits, ...unmatchedDirectMainCommits, ...unmatchedActiveBranchSubmissions]
    },
  }
}
