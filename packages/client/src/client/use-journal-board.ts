/** Own the visible board's read lifecycle and serialized, revision-bound edits. */
import { useEffect, useRef, useState } from 'react'
import type { JournalEvent, JournalRow } from '@xrunmasterx/dsh-personal-host/client'
import type { JournalActions } from './journal-api.ts'
import { localDay } from './journal-calendar.ts'

type State = {
  rows: JournalRow[]
  today: string
  loading: boolean
  busy: boolean
  needsSync: boolean
  error: string
  saved: boolean
  undo: JournalEvent | null
}
type Controls = {
  refresh: () => Promise<void>
  run: (operation: () => Promise<void>) => Promise<void>
  changed: (receipt?: JournalEvent) => void
}

/**
 * Read only while visible, discard superseded pages, and unlock edits after authoritative refresh.
 * @param api - journal read capability; mutations run through the caller's revision-bound operation.
 * @param pollIntervalMs - configured foreground polling interval.
 * @returns board state and lifecycle-owned read/write controls.
 */
export function useJournalBoard(api: Pick<JournalActions, 'journalQuery'>, pollIntervalMs: number): State & Controls {
  const [state, setState] = useState<State>(() => ({
    rows: [],
    today: localDay(),
    loading: true,
    busy: false,
    needsSync: false,
    error: '',
    saved: false,
    undo: null,
  }))
  const controls = useRef<Controls | null>(null)
  useEffect(() => {
    let disposed = false
    let generation = 0
    let writing = false
    let committed = false
    let recovering = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const live = () => !disposed
    const didCommit = () => committed
    const schedule = () => {
      clearTimeout(timer)
      if (live() && !writing && !document.hidden) timer = setTimeout(() => void read(), pollIntervalMs)
    }
    const read = async (afterWrite = false) => {
      if (!live() || (writing && !afterWrite) || (document.hidden && !afterWrite)) return
      clearTimeout(timer)
      const version = ++generation
      const current = () => live() && version === generation
      try {
        const rows: JournalRow[] = []
        let offset: number | null = 0
        do {
          const page = await api.journalQuery({ from: null, to: null, text: '', includeOpen: true, offset })
          if (!current()) return
          rows.push(...page.items)
          offset = page.nextOffset
        } while (offset !== null)
        recovering = false
        setState((previous) => {
          const unchanged =
            previous.rows.length === rows.length &&
            rows.every((row, index) => {
              const old = previous.rows[index]
              return old?.eventId === row.eventId && old.revision === row.revision && old.order === row.order
            })
          const today = localDay()
          if (
            unchanged &&
            previous.today === today &&
            previous.busy === writing &&
            !previous.loading &&
            !previous.error &&
            !previous.needsSync
          )
            return previous
          return {
            ...previous,
            rows: unchanged ? previous.rows : rows,
            today,
            loading: false,
            needsSync: false,
            busy: writing,
            error: '',
          }
        })
      } catch (error) {
        if (current()) {
          recovering ||= afterWrite
          setState(previous => ({
            ...previous,
            loading: false,
            busy: writing || recovering,
            needsSync: recovering,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      } finally {
        if (current()) schedule()
      }
    }
    const owned: Controls = {
      refresh: () => read(),
      changed: (receipt) => {
        committed = true
        if (live())
          setState(previous => ({
            ...previous,
            saved: true,
            undo: receipt ? (receipt.operation === 'undo' ? null : receipt) : previous.undo,
          }))
      },
      run: async (operation) => {
        if (!live() || writing || recovering) return
        writing = true
        committed = false
        generation++
        clearTimeout(timer)
        setState(previous => ({ ...previous, busy: true, error: '', saved: false }))
        try {
          await operation()
          if (live() && didCommit()) await read(true)
        } catch (error) {
          if (live()) {
            recovering ||= didCommit()
            setState(previous => ({
              ...previous,
              needsSync: recovering,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        } finally {
          writing = false
          if (live()) setState(previous => ({ ...previous, busy: recovering }))
          schedule()
        }
      },
    }
    controls.current = owned
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(timer)
        if (!writing) generation++
      } else void read()
    }
    document.addEventListener('visibilitychange', visibility)
    void read()
    return () => {
      disposed = true
      generation++
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
      if (controls.current === owned) controls.current = null
    }
  }, [api, pollIntervalMs])
  return {
    ...state,
    refresh: () => controls.current?.refresh() ?? Promise.resolve(),
    run: (operation: () => Promise<void>) => controls.current?.run(operation) ?? Promise.resolve(),
    changed: (receipt?: JournalEvent) => controls.current?.changed(receipt),
  }
}
