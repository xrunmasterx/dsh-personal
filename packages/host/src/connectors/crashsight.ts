/** Exact CrashSight read operations used by boards and evidence collection. */
import { ReadOnlyMcp, type McpEndpoint } from './mcp.ts'

/** Evidence reads retain the original explicit Report and shared-link semantics. */
export const CRASHSIGHT_INCIDENT_READ_TOOLS = [
  'fetch_last_crash_detail_in_issue',
  'get_report_detail',
  'get_report_attachments',
  'fetch_crash_detail_by_share_id',
  'fetch_crash_attachment_by_share_id',
] as const
/** The collector's admitted detail methods. */
export type CrashSightIncidentReadToolName = (typeof CRASHSIGHT_INCIDENT_READ_TOOLS)[number]
const reads = new Set<string>([
  ...CRASHSIGHT_INCIDENT_READ_TOOLS,
  'advanced_issue_search',
  'query_crash_list',
  'get_app_info_list',
  'query_issue_trend',
])

/**
 * Open one connection whose method allowlist contains no external writes.
 * @param endpoint - configured endpoint and cancellation.
 * @returns the read connection, closed by its caller.
 */
export async function openCrashSight(endpoint: McpEndpoint): Promise<ReadOnlyMcp> {
  return await ReadOnlyMcp.open(endpoint, reads)
}
