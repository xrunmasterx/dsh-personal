/** Read-only Git facts using the retained semantic-commit selection rules. */
import type { Context } from '@deepseek-ai/cordis'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Config } from '../config.ts'
import { createGitCliFromExecutor } from './cli.ts'
import { gitActivitySchema, type GitActivity, type GitActivityCommit } from './schema.ts'
import { selectSemanticCommit } from './semantic.ts'
import { buildCommitWebUrl } from './web-url.ts'
import { readGitCommand } from './process.ts'

/**
 * Collect the configured authors' last 90 days from existing local refs only.
 * @param ctx - Host with the subprocess provider.
 * @param config - explicit repository and author scopes.
 * @param signal - collection lifetime.
 * @returns semantic Git activity; missing required refs reject rather than imply no work.
 */
export async function readGitActivity(ctx: Context, config: Config, signal: AbortSignal): Promise<GitActivity> {
  if (!config.gitSources.length) throw new Error('No Git evidence source is configured')
  const cli = createGitCliFromExecutor((cwd, args) => readGitCommand(ctx, config, cwd, args, signal))
  const now = new Date()
  const windowStart = new Date(now.getTime() - 90 * 86_400_000)
  const commits: GitActivityCommit[] = []
  const observations: NonNullable<GitActivity['observations']> = []
  for (const source of config.gitSources) {
    signal.throwIfAborted()
    const info = await cli.inspectRepository(source.path, source.targetMainRef || null)
    if (!info.targetMainRef || !info.targetMainSha || !info.carStableSha)
      throw new Error('Configured Git evidence refs are unavailable locally')
    const fetchResult = await readGitCommand(ctx, config, source.path, ['rev-parse', '--git-path', 'FETCH_HEAD'], signal)
    if (fetchResult.exitCode !== 0) throw new Error('Could not inspect the local Git fetch history')
    const fetchPath = fetchResult.stdout.trim()
    let fetchedAt: string | null = null
    try {
      fetchedAt = (await stat(resolve(source.path, fetchPath))).mtime.toISOString()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    observations.push({
      repositoryId: source.id,
      targetMainRef: info.targetMainRef,
      targetMainSha: info.targetMainSha,
      fetchedAt,
    })
    const facts = await cli.readFinalCommits({
      repositoryId: source.id,
      repositoryPath: source.path,
      currentBranch: info.currentBranch,
      targetMainRef: info.targetMainRef,
      targetMainSha: info.targetMainSha,
      carStableRef: info.carStableRef,
      carStableSha: info.carStableSha,
      authorEmails: source.authors,
      windowStart,
      windowEnd: now,
      collectedAt: now,
    })
    for (const fact of facts) {
      const selected = selectSemanticCommit({ finalCommit: fact, authorEmails: source.authors })
      commits.push({
        ...fact,
        semanticCommit: selected.commit,
        semanticCommitSource: selected.source,
        ...(info.repositoryWebUrl
          ? {
            semanticCommitUrl: buildCommitWebUrl(info.repositoryWebUrl, selected.commit.sha),
            carStableCommitUrl: buildCommitWebUrl(info.repositoryWebUrl, fact.sha),
            ...(fact.mainIntegration
              ? { mainIntegrationCommitUrl: buildCommitWebUrl(info.repositoryWebUrl, fact.mainIntegration.sha) }
              : {}),
          }
          : {}),
      })
    }
  }
  signal.throwIfAborted()
  const unique = [...new Map(commits.map(commit => [`${commit.repositoryId}:${commit.sha}`, commit])).values()]
  return gitActivitySchema.parse({
    range: '90d',
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    commits: unique,
    observations,
    summary: {
      commitCount: unique.length,
      repositoryCount: config.gitSources.length,
      filesChanged: new Set(
        unique.flatMap(commit => commit.files.map(file => `${commit.repositoryId}:${file.path}`)),
      ).size,
      additions: unique.reduce((sum, commit) => sum + commit.additions, 0),
      deletions: unique.reduce((sum, commit) => sum + commit.deletions, 0),
      byDay: [],
    },
  })
}
