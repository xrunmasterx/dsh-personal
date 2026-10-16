/** Tab-local unsaved task documents; completed and discarded drafts leave no stored entry. */
import { useState } from 'react'

type Draft = { text: string; base: string; title?: string; baseTitle?: string }

/**
 * Preserve unsaved text through navigation and reload without writing journal facts.
 * @param itemId - durable task identity.
 * @returns draft editor and whether tab-local storage failed.
 */
export function useTaskDraft(itemId: string): {
  editor: Draft | null
  update: (draft: Draft | null) => void
  storageFailed: boolean
} {
  const key = `personal-workbench/task-draft/${itemId}`
  const [storageFailed, setStorageFailed] = useState(false)
  const [editor, setEditor] = useState<Draft | null>(() => {
    try {
      const raw = sessionStorage.getItem(key)
      if (!raw) return null
      const value: unknown = JSON.parse(raw)
      if (
        typeof value === 'object' &&
        value !== null &&
        'text' in value &&
        'base' in value &&
        typeof value.text === 'string' &&
        typeof value.base === 'string' &&
        value.text.length <= 20_000 &&
        value.base.length <= 20_000 &&
        (!('title' in value) || (typeof value.title === 'string' && value.title.length <= 1000)) &&
        (!('baseTitle' in value) || (typeof value.baseTitle === 'string' && value.baseTitle.length <= 1000))
      )
        return {
          text: value.text, base: value.base,
          ...('title' in value ? { title: value.title as string } : {}),
          ...('baseTitle' in value ? { baseTitle: value.baseTitle as string } : {}),
        }
      return null
    } catch {
      // Unavailable browser storage or invalid prior JSON cannot replace the authoritative document.
      return null
    }
  })
  return {
    editor,
    storageFailed,
    update: (draft) => {
      setEditor(draft)
      try {
        if (draft && (draft.text !== draft.base || draft.title !== draft.baseTitle)) sessionStorage.setItem(key, JSON.stringify(draft))
        else sessionStorage.removeItem(key)
        setStorageFailed(false)
      } catch {
        // Quota or privacy restrictions retain the in-memory draft and expose its limited lifetime.
        setStorageFailed(true)
      }
    },
  }
}
