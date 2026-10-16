/** Personal workbench tapd/normalize; business rules migrated from ai-workflow. */

import type { TapdTodoRawItem, TapdTodoRawItems } from '../connectors/tapd.ts'
import type { TapdTodoItem } from './schema.ts'

function readText(item: TapdTodoRawItem, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }

  return undefined
}

function requireText(item: TapdTodoRawItem, keys: string[], field: string): string {
  const value = readText(item, keys)
  if (!value) {
    throw new Error(`TAPD todo item is missing ${field}.`)
  }

  return value
}

function normalizeItem(kind: TapdTodoItem['kind'], workspaceId: string, item: TapdTodoRawItem): TapdTodoItem {
  const itemWorkspaceId = readText(item, ['workspace_id']) ?? workspaceId
  if (itemWorkspaceId !== workspaceId) {
    throw new Error('TAPD returned an item outside the requested workspace.')
  }

  const id = requireText(item, ['id'], 'id')
  const title = requireText(item, ['title', 'name'], 'title')
  const status = requireText(item, ['status'], 'status')

  return {
    key: `tapd:${workspaceId}:${kind}:${id}`,
    kind,
    id,
    workspaceId,
    title,
    status,
    priority: readText(item, ['priority']),
    owner: readText(item, ['current_owner', 'owner']),
    createdAt: readText(item, ['created']),
    iteration: readText(item, ['iteration']),
  }
}

function normalizeKind(kind: TapdTodoItem['kind'], workspaceId: string, items: TapdTodoRawItem[]): TapdTodoItem[] {
  return items.map(item => normalizeItem(kind, workspaceId, item))
}

function assertUnique(items: TapdTodoItem[]): TapdTodoItem[] {
  const keys = new Set(items.map(item => item.key))
  if (keys.size !== items.length) throw new Error('TAPD returned duplicate todo item identities.')
  return items
}

/**
 * Normalize personal stories, defects and tasks while preserving workspace-scoped identity.
 * @param workspaceId - workspace owning these work items.
 * @param rawItems - provider items grouped by their original object category.
 * @returns normalized workspace-scoped work items.
 */
export function normalizeTapdTodoItems(workspaceId: string, rawItems: TapdTodoRawItems): TapdTodoItem[] {
  return assertUnique([
    ...normalizeKind('story', workspaceId, rawItems.stories),
    ...normalizeKind('bug', workspaceId, rawItems.bugs),
    ...normalizeKind('task', workspaceId, rawItems.tasks),
  ])
}

/**
 * Normalize the token owner's cross-project todo result using each row's workspace identity.
 * @param rawItems - unscoped personal items grouped by their original object category.
 * @returns normalized work items without assigning a configured workspace to external rows.
 */
export function normalizePersonalTapdTodoItems(rawItems: TapdTodoRawItems): TapdTodoItem[] {
  const workspace = (item: TapdTodoRawItem): string => {
    const id = requireText(item, ['workspace_id'], 'workspace_id')
    if (!/^\d+$/.test(id)) throw new Error('TAPD todo item has an invalid workspace_id.')
    return id
  }
  return assertUnique([
    ...rawItems.stories.map(item => normalizeItem('story', workspace(item), item)),
    ...rawItems.bugs.map(item => normalizeItem('bug', workspace(item), item)),
    ...rawItems.tasks.map(item => normalizeItem('task', workspace(item), item)),
  ])
}
