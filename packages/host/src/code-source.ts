/** Gongfeng reads admitted to the periodic importer; no repository mutation tools are exposed. */
import { z } from 'zod'
import { mcpPayload } from './connectors/mcp.ts'

/** Transport used by the collector and deterministic source fixtures. */
export interface CodeSource {
  execute(name: string, args: Record<string, unknown>): Promise<unknown>
  disconnect(): Promise<void>
}
/** Exact read allowlist for the background source. */
export const CODE_READS = new Set(['get_project_detail', 'get_branch_list', 'get_commits_list', 'get_commit_diff', 'compare', 'get_commit_info'])
/** Validated external commit metadata. */
export const sourceCommitSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{40,64}$/), title: z.string(), message: z.string(),
  author_name: z.string(), author_email: z.string(), committed_date: z.string(),
})
/** Source commit accepted for persistence. */
export type SourceCommit = z.infer<typeof sourceCommitSchema>
/**
 * Resolve only an explicit Gongfeng repository URL or project path.
 * @param input User preference.
 * @returns Full namespace/project path.
 */
export function codeProject(input: string): string {
  let path = input.trim()
  if (path.includes('://')) {
    const url = new URL(path)
    if (url.protocol !== 'https:' || url.hostname !== 'git.woa.com' || url.username || url.password || url.search || url.hash)
      throw new Error('Use an HTTPS git.woa.com repository URL without credentials or query parameters')
    path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '')
  }
  path = path.replace(/\.git$/, '')
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) throw new Error('Invalid Gongfeng project path')
  return path
}
/**
 * Read every source page, failing rather than accepting malformed or repeated pages.
 * @param source Open read-only connection.
 * @param tool Admitted paginated tool.
 * @param args Exact scope.
 * @param signal Import cancellation.
 * @returns Complete list for the requested source query.
 */
export async function codePages(source: CodeSource, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown[]> {
  const rows: unknown[] = []
  let previous = ''
  for (let page = 1; ; page++) {
    signal.throwIfAborted()
    const payload = mcpPayload(await source.execute(tool, { ...args, page, per_page: 100 }))
    if (!Array.isArray(payload)) {
      const error = z.object({ message: z.string().optional() }).safeParse(payload)
      throw new Error(`${tool} page ${page}: ${error.success ? error.data.message ?? 'Expected a list' : 'Invalid source response'}`)
    }
    const batch: unknown[] = payload
    if (!batch.length) return rows
    const fingerprint = JSON.stringify(batch)
    if (fingerprint === previous) throw new Error('Gongfeng repeated a page; collection is incomplete')
    previous = fingerprint
    rows.push(...batch)
    if (batch.length < 100) return rows
  }
}
/**
 * Preserve all returned text while rejecting a provider-truncated patch.
 * @param envelope MCP diff result.
 * @returns File-delimited patch for analysis and retention.
 */
export function codeDiff(envelope: unknown): string {
  const rows = z.array(z.object({ old_path: z.string(), new_path: z.string(), diff: z.string(),
    is_too_large: z.boolean().optional(), is_collapse: z.boolean().optional() })).parse(mcpPayload(envelope))
  if (rows.some(row => row.is_too_large || row.is_collapse)) throw new Error('Gongfeng omitted part of the diff; full analysis is pending')
  return rows.map(row => `File: ${row.old_path} -> ${row.new_path}\n${row.diff}`).join('\n\n')
}

/**
 * Discover every commit introduced between frozen heads, including old-dated merges.
 * @param source Open read-only connection.
 * @param project Project identifier.
 * @param from Previously committed checkpoint.
 * @param to Head observed at scan start.
 * @returns Complete comparison metadata; incomplete comparisons never advance checkpoints.
 */
export async function codeChanges(source: CodeSource, project: string, from: string, to: string): Promise<unknown[]> {
  const result = z.object({ compare_timeout: z.boolean(), over_flow: z.boolean(), commits_total: z.number(),
    commits: z.array(z.unknown()).nullable().optional(), compare_same_ref: z.boolean(),
  }).parse(mcpPayload(await source.execute('compare', { project_id: project, from, to, straight: false })))
  if (result.compare_timeout || result.over_flow || (!result.compare_same_ref && result.commits?.length !== result.commits_total))
    throw new Error('Gongfeng comparison is incomplete; the previous checkpoint is retained')
  return result.commits ?? []
}
