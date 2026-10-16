/** Git evidence projection migrated from ai-workflow. */
import type { GitCommitFact, GitFinalCommitFact, GitProcessCommitFact, GitSemanticCommitSource } from './schema.ts'

const MIN_PROCESS_SCORE = 0.5

type SemanticCommitSelection = {
  commit: GitCommitFact
  source: GitSemanticCommitSource
}

type ScoredCommit = {
  commit: GitProcessCommitFact
  score: number
}

function overlapSize(left: Set<string>, right: Set<string>): number {
  let size = 0
  for (const value of left) {
    if (right.has(value)) size += 1
  }
  return size
}

function changeMagnitude(commit: GitCommitFact): number {
  return commit.additions + commit.deletions
}

function magnitudeSimilarity(left: GitCommitFact, right: GitCommitFact): number {
  const leftMagnitude = Math.log1p(changeMagnitude(left))
  const rightMagnitude = Math.log1p(changeMagnitude(right))
  const scale = Math.max(leftMagnitude, rightMagnitude, 1)
  return Math.max(0, 1 - Math.abs(leftMagnitude - rightMagnitude) / scale)
}

function subjectQuality(subject: string): number {
  const normalized = subject.replace(/\s+/g, ' ').trim()
  if (!normalized) return 0

  const genericWorkflowSubject =
    /^(merge(?:d)?|cherry[- ]pick(?:ed)?|sync(?:hronize)?|revert)\b/i.test(normalized) ||
    /^(合并|同步|回滚|撤销)/.test(normalized) ||
    /\bmerge request\b/i.test(normalized)
  const lengthSignal = Math.min(normalized.length / 40, 1)
  const cjkTieBreaker = /[\u3400-\u9fff]/u.test(normalized) ? 0.05 : 0
  const quality = lengthSignal + cjkTieBreaker
  return Math.min(genericWorkflowSubject ? quality * 0.2 : quality, 1)
}

function scoreCandidate(finalCommit: GitFinalCommitFact, candidate: GitProcessCommitFact): number {
  const finalFiles = new Set(finalCommit.files.map(file => file.path))
  const candidateFiles = new Set(candidate.files.map(file => file.path))
  const sharedFiles = overlapSize(finalFiles, candidateFiles)
  const coverage = finalFiles.size ? sharedFiles / finalFiles.size : 0
  const precision = candidateFiles.size ? sharedFiles / candidateFiles.size : 0
  const exactSource = candidate.relation === 'cherry_pick_source' ? 1 : 0

  return (
    coverage * 0.5 +
    precision * 0.15 +
    magnitudeSimilarity(finalCommit, candidate) * 0.2 +
    subjectQuality(candidate.subject) * 0.1 +
    exactSource * 0.05
  )
}

/**
 * Select allowed-author work behind a final integration, retaining an explicit fallback.
 * @param input - the frozen source records and operation settings.
 * @returns the selected authored commit and whether it required a fallback.
 */
export function selectSemanticCommit(input: {
  finalCommit: GitFinalCommitFact
  authorEmails: string[]
}): SemanticCommitSelection {
  const allowedEmails = new Set(input.authorEmails.map(email => email.toLowerCase()))
  const candidates = input.finalCommit.processCommits
    .filter(commit => allowedEmails.has(commit.authorEmail.toLowerCase()))
    .filter(commit => commit.parents.length <= 1)
    .map(commit => ({
      commit,
      score: scoreCandidate(input.finalCommit, commit),
    }))
  candidates.sort((left, right) => {
    const scoreOrder = right.score - left.score
    if (scoreOrder !== 0) return scoreOrder
    const dateOrder = left.commit.authorDate.localeCompare(right.commit.authorDate)
    if (dateOrder !== 0) return dateOrder
    return left.commit.sha.localeCompare(right.commit.sha)
  })
  const selected: ScoredCommit | undefined = candidates[0]

  if (!selected || selected.score < MIN_PROCESS_SCORE) {
    return { commit: input.finalCommit, source: 'integration_fallback' }
  }

  return { commit: selected.commit, source: 'process_history' }
}
