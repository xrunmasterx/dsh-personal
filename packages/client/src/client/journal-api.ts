import type { CodeActions } from './CodeArchive.tsx'
import type { ReviewActions } from './Retrospective.tsx'
/** Journal view capabilities, independent of React components. */
import type { BriefPolishRequest, PolishedBrief, TaskSession, JournalId } from '@xrunmasterx/dsh-personal-host/client'
import type { HistoryActions } from './History.tsx'
import type { WorkbenchClient } from './data.ts'

/** Shared plain callbacks; all records are owned by the Host. */
export type JournalActions = Pick<
  WorkbenchClient,
  | 'journalUploadImage'
  | 'journalReadImage'
  | 'journalQuery'
  | 'journalWrite'
  | 'journalHistory'
  | 'journalActivity'
  | 'journalWeek'
  | 'journalReport'
  | 'journalSaveReport'
  | 'journalEvent'
> & {
  reviews?: ReviewActions
  code?: CodeActions
  history?: HistoryActions
  polishBrief: (text: string, mode?: BriefPolishRequest['mode'], status?: BriefPolishRequest['status']) => Promise<PolishedBrief>
  assist: (text: string) => Promise<void>
  archiveTaskSession: (session: TaskSession) => Promise<void>
  beginBoardSession: (week: string, signal: AbortSignal) => Promise<void>
  beginTaskSession: (taskId: JournalId, title: string, signal: AbortSignal, fresh?: boolean) => Promise<() => void>
  openTaskSession: (session: TaskSession, taskId: JournalId) => Promise<void>
}
