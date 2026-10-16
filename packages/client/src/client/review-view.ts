/** Tab-local review navigation and unsaved corrections, separate from published facts. */
import { useRef, useState } from 'react'
import type { ReviewEdit } from '@xrunmasterx/dsh-personal-host/client'
import { localDay } from './journal-calendar.ts'

/** Descriptive filters shared by cards and the correction editor. */
export const reviewCategories = ['development', 'debug', 'learning', 'performance', 'discussion', 'other'] as const
const key = 'personal-workbench/review-view/v1'
type View = { day: string; mode: 'day' | 'week' | 'legacy'; query: string; category: string; expanded: string[]; evidence: string[]; editor: ReviewEdit | null; editorDay: string }
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string')
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
function read(): View {
  const empty: View = { day: localDay(), mode: 'day', query: '', category: '', expanded: [], evidence: [], editor: null, editorDay: localDay() }
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (!raw || typeof raw !== 'object') return empty
    const value = raw as Record<string, unknown>
    let editor: ReviewEdit | null = null
    if (value.editor && typeof value.editor === 'object') {
      const e = value.editor as Record<string, unknown>
      if (e.activity && typeof e.activity === 'object') {
        const a = e.activity as Record<string, unknown>
        if (typeof e.id === 'string' && a.id === e.id && typeof e.expectedRevision === 'number' && Number.isInteger(e.expectedRevision) && e.expectedRevision >= 0
          && typeof e.hidden === 'boolean' && date(a.day) && typeof a.title === 'string' && typeof a.markdown === 'string'
          && strings(a.tags) && a.tags.every(t => reviewCategories.some(c => c === t)) && strings(a.taskIds) && strings(a.evidence)) {
          // IDs are parsed again by the Host before a persisted write.
          editor = value.editor as ReviewEdit
        }
      }
    }
    return { day: date(value.day) ? value.day : empty.day, mode: value.mode === 'week' || value.mode === 'legacy' ? value.mode : 'day',
      query: typeof value.query === 'string' ? value.query : '', category: reviewCategories.some(c => c === value.category) ? String(value.category) : '',
      expanded: strings(value.expanded) ? value.expanded : [], evidence: strings(value.evidence) ? value.evidence : [], editor,
      editorDay: date(value.editorDay) ? value.editorDay : editor?.activity.day ?? empty.day }
  } catch {
    // Corrupt or blocked tab storage cannot replace published records.
    return empty
  }
}

/** Retain reading choices and a single unsaved editor through navigation and reload.
 * @returns View state, partial update and a visible storage failure flag.
 */
export function useReviewView(): { view: View; update: (patch: Partial<View>) => void; storageFailed: boolean } {
  const [view, setView] = useState(read)
  const current = useRef(view)
  const [storageFailed, setStorageFailed] = useState(false)
  const update = (patch: Partial<View>) => {
    const next = { ...current.current, ...patch }; current.current = next
    setView(next)
    try { sessionStorage.setItem(key, JSON.stringify(next)); setStorageFailed(false) }
    catch {
      // Quota/privacy failures retain the mounted editor but cannot promise reload recovery.
      setStorageFailed(true)
    }
  }
  return { view, update, storageFailed }
}
