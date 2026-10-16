/** TAPD gateway reads shared by the board and incident collector. */
import { ReadOnlyMcp, isRecord, mcpPayload, type McpEndpoint } from './mcp.ts'

/** The original personal work-item sources; refreshing them never starts an Agent. */
export const TAPD_TODO_READS = [
  { kind: 'stories', toolName: 'user_todo_stories_get' },
  { kind: 'bugs', toolName: 'user_todo_bugs_get' },
  { kind: 'tasks', toolName: 'user_todo_tasks_get' },
] as const

/** Personal work-item source kinds. */
export type TapdTodoKind = (typeof TAPD_TODO_READS)[number]['kind']
/** Untrusted rows awaiting the existing work-item normalizer. */
export type TapdTodoRawItems = Record<TapdTodoKind, Record<string, unknown>[]>
/** Counts computed from a complete personal snapshot. */
export type TapdTodoCounts = Record<TapdTodoKind, number>
/** Raw gateway record. */
export type TapdTodoRawItem = Record<string, unknown>

const reads = new Set<string>([
  ...TAPD_TODO_READS.map(read => read.toolName),
  'bugs_get',
  'stories_get',
  'tasks_get',
  'comments_get',
])

/**
 * Open the TAPD proxy while admitting only this feature's read operations.
 * @param endpoint - configured endpoint and Host credentials.
 * @returns a business-name adapter with caller-owned teardown.
 */
export async function openTapd(
  endpoint: McpEndpoint,
): Promise<{ execute(name: string, args: Record<string, unknown>): Promise<unknown>; disconnect(): Promise<void> }> {
  const client = await ReadOnlyMcp.open(endpoint, new Set(['proxy_execute_tool']))
  return {
    execute(name, args) {
      if (!reads.has(name)) throw new Error(`TAPD operation is not an admitted read: ${name}`)
      return client.execute('proxy_execute_tool', { tool_name: name, tool_args: args })
    },
    disconnect: () => client.disconnect(),
  }
}

/**
 * Preserve the TAPD gateway's explicit empty-list response.
 * @param result - external MCP result.
 * @returns raw personal work-item rows; transport and unsupported responses fail.
 */
export function parseTapdTodoItems(result: unknown): Record<string, unknown>[] {
  const payload = mcpPayload(result)
  if (Array.isArray(payload) && payload.every(isRecord)) return payload
  if (typeof payload === 'string' && payload.includes('没有待办任务')) return []
  throw new Error('TAPD returned an unsupported personal work-item response')
}
