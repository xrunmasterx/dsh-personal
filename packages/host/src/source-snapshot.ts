/** Source version observations for reports produced against mutable local checkouts. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Config } from './config.ts'
import { redactDiagnostic } from './diagnostics.ts'
import { readGitCommand } from './git/process.ts'
import type { SourceSnapshot } from './models.ts'

/**
 * Observe the harness checkout and each configured Git source without fetching or modifying them.
 * @param ctx - Host subprocess owner.
 * @param config - explicit source repositories and read limits.
 * @param signal - investigation lifetime.
 * @returns known versions, local changes and explicit unavailable-source diagnostics.
 */
export async function captureSources(ctx: Context, config: Config, signal: AbortSignal): Promise<SourceSnapshot> {
  const manifest = z
    .object({ version: z.string() })
    .parse(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as unknown)
  const sources = [
    { id: 'DSH', path: fileURLToPath(new URL('../../../../', import.meta.url)), targetMainRef: 'HEAD' },
    ...config.gitSources,
  ]
  const repositories = await Promise.all(
    sources.map(async (source): Promise<SourceSnapshot['repositories'][number]> => {
      const base = {
        name: source.id,
        path: source.path,
        head: null,
        ref: source.targetMainRef,
        refSha: null,
        trackedChanges: 0,
        dirtyDigest: null,
        fetchedAt: null,
        error: null,
      }
      try {
        const read = async (args: string[]) => {
          const result = await readGitCommand(ctx, config, source.path, args, signal)
          if (result.exitCode) throw new Error(result.stderr)
          return result.stdout.trim()
        }
        const [head, refSha, dirty, fetchPath] = await Promise.all([
          read(['rev-parse', 'HEAD']),
          read(['rev-parse', '--verify', source.targetMainRef]),
          read(['status', '--porcelain', '--untracked-files=normal']),
          read(['rev-parse', '--git-path', 'FETCH_HEAD']),
        ])
        let fetchedAt: string | null = null
        try {
          fetchedAt = (await stat(resolve(source.path, fetchPath))).mtime.toISOString()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const patch = dirty ? await read(['diff', 'HEAD', '--no-ext-diff', '--no-textconv']) : ''
        return {
          ...base,
          head,
          refSha,
          fetchedAt,
          trackedChanges: dirty ? dirty.split('\n').length : 0,
          dirtyDigest: createHash('sha256').update(`${dirty}\n${patch}`).digest('hex'),
        }
      } catch (error) {
        signal.throwIfAborted()
        return {
          ...base,
          error: redactDiagnostic(error instanceof Error ? error.message : 'Source version unavailable', 500),
        }
      }
    }),
  )
  return { harnessVersion: manifest.version, capturedAt: new Date().toISOString(), repositories }
}

/**
 * Detect observed checkout or ref changes during one execution.
 * @param start - initial source observation.
 * @param end - final source observation.
 * @returns whether source content or availability changed.
 */
export function sourcesChanged(start: SourceSnapshot, end: SourceSnapshot): boolean {
  const keys = (snapshot: SourceSnapshot) =>
    snapshot.repositories.map(({ path, head, refSha, dirtyDigest, error }) => ({
      path,
      head,
      refSha,
      dirtyDigest,
      error,
    }))
  return JSON.stringify(keys(start)) !== JSON.stringify(keys(end))
}
