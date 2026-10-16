/** Personal workbench tapd/schema; business rules migrated from ai-workflow. */

import { z } from 'zod'

const tapdTodoKindSchema = z.enum(['story', 'bug', 'task'])

const tapdTodoItemSchema = z.object({
  key: z.string().min(1),
  kind: tapdTodoKindSchema,
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().min(1),
  status: z.string().min(1),
  priority: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  createdAt: z.string().min(1).optional(),
  iteration: z.string().min(1).optional(),
})

const tapdTodoCountsSchema = z.object({
  stories: z.number().int().nonnegative(),
  bugs: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
})

/**
 * Validate a successful personal-work-item snapshot and its cache expiry.
 */
export const tapdTodoSnapshotSchema = z.object({
  workspaceIds: z.array(z.string().min(1)),
  items: z.array(tapdTodoItemSchema),
  counts: tapdTodoCountsSchema,
  total: z.number().int().nonnegative(),
  fetchedAt: z.string().min(1),
  cacheExpiresAt: z.string().min(1),
})

/**
 * A personal work item with its workspace, category and provider status.
 */
export type TapdTodoItem = z.infer<typeof tapdTodoItemSchema>
/**
 * The last successful personal work-item collection and its freshness times.
 */
export type TapdTodoSnapshot = z.infer<typeof tapdTodoSnapshotSchema>
