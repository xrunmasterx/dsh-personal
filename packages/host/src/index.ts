import type {} from '@deepseek-ai/dsh-api-session-controller'
import { PersonalRecords } from './personal-records.ts'
export { PersonalRecords } from './personal-records.ts'
import { Reviews } from './reviews.ts'
import { reviewInputs } from './review-sources.ts'
import type { ReviewWeek, ReviewEdit, ReviewSource, ReviewSourceId } from './review-schema.ts'
import type {} from '@deepseek-ai/dsh-attachment'
import { TaskImages } from './task-images.ts'
import { CodeHistory } from './code-history.ts'
import type { CodeId, CodePage, CodeRecord } from './code-schema.ts'
/** Personal workbench Host: typed Remote methods over one durable business owner. */
import { TaskContext } from './task-context.ts'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Config } from './config.ts'
import type {
  CrashPage,
  CrashQuery,
  InvestigationPlan,
  PlanId,
  PlanRequest,
  ProfilePublication,
  ProfileRecord,
  PublishRequest,
  ReportPage,
  ReviewRequest,
  RunId,
  RunRecord,
  TapdCache,
  WorkbenchInfo,
  RunQuery, RunPage, ProfileId, ProfileView, WorkbenchChanges,
  CrashDetails, EvidencePreview,
  LinkedCrashPage, LinkedCrashQuery,
} from './models.ts'
import { profileIdSchema } from './models.ts'
import { queryRuns, queryProfile, queryChanges, queryLinkedCrashes } from './queries.ts'
import type { CleanupToken, CleanupPreview, CleanupResult, StorageUsage } from './storage.ts'
import type { InvestigationReportContent } from './incident/schema.ts'
import type { PersonalProfileEvidenceSnapshot } from './profile/schema.ts'
import { polishBrief, type BriefPolishRequest, type PolishedBrief } from './brief-polish.ts'
import { installBriefSettings } from './brief-settings.ts'
import { ConversationHistory } from './history.ts'
import type { HistoryId, HistoryPage, HistoryRule, HistoryMessage } from './history-schema.ts'
import { WorkbenchRuntime } from './runtime.ts'
import { WorkbenchStore } from './store.ts'
import { WorkJournal, type JournalId, type JournalWrite, type JournalQuery, type JournalReportWrite, type JournalPage, type JournalEvent, type JournalWeek, type JournalReport } from './journal.ts'

export type * from './client.ts'
export { Config } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalWorkbench: PersonalWorkbench
  }
}

/** Runtime capabilities required by this business Host. */
export const inject = ['jobs', 'storageDomain', 'subprocess', 'credentials', 'llm', 'sessions', 'systemPrompt', 'attachments', 'sessionController']

/** Explicit Host capability selected by the Personal browser assembly. */
export class PersonalWorkbench extends TypertRemoteService {
  /** Read active business operations without exposing task content or starting work.
   * @returns Whether an updater should defer replacing this process.
   */
  maintenanceBusy(): boolean {
    const changes = queryChanges(this.runtime.store)
    return this.polishing > 0 || this.history.isRunning || this.code.isRunning || this.reviews.isRunning
      || changes.activeRuns.length > 0 || changes.activeProfiles.length > 0
  }
  constructor(
    ctx: Context,
    readonly runtime: WorkbenchRuntime,
    readonly journal: WorkJournal,
    readonly history: ConversationHistory,
    readonly code: CodeHistory,
    readonly reviews: Reviews,
  ) {
    super(ctx, 'personalWorkbench')
    this.taskContext = new TaskContext(ctx, journal)
    this.briefPolicy = installBriefSettings(ctx, runtime.config.briefPolish)
  }

  /** Read daily and weekly retrospective results.
   * @param day A date in the requested week.
   * @returns Retained activities and analysis health.
   */
  @Remote
  reviewRead(day: string): ReviewWeek { return this.reviews.read(day) }

  /** Request background catch-up for one week.
   * @param day A date in the requested week.
   */
  @Remote
  reviewSync(day: string): void { void this.reviews.sync(day) }

  /** Save a human correction without changing tasks.
   * @param request Activity edit with expected revision.
   * @returns Completion after durable persistence.
   */
  @Remote
  reviewEdit(request: ReviewEdit): Promise<void> { return this.reviews.edit(request) }

  /** Read cited evidence.
   * @param id Published source identity.
   * @returns Retained text and source metadata.
   */
  @Remote
  reviewSource(id: ReviewSourceId): ReviewSource { return this.reviews.source(id) }

  /**
   * Paged external conversations with scan health.
   * @param taskId - task filter, or null for the archive.
   * @param mode - inbox, all or ignored records.
   * @param offset - page cursor.
   * @param text - title, summary or identity search, applied before pagination.
   * @param source - application filter.
   * @returns bounded cards and background state.
   */
  @Remote
  historyList(taskId: string | null, mode: 'inbox' | 'all' | 'ignored', offset: number, text?: string,
    source?: 'all' | 'codex' | 'cursor'): HistoryPage { return this.history.list(taskId, mode, offset, text, source) }

  /**
   * Read retained messages independently of source availability.
   * @param id - external conversation identity.
   * @param offset - message page cursor.
   * @returns retained messages and next cursor.
   */
  @Remote
  historyRead(id: HistoryId, offset: number): { messages: HistoryMessage[]; nextOffset: number | null } {
    return this.history.read(id, offset)
  }

  /**
   * Start or join the single archive run without blocking the browser.
   * @param retry - reset failed-item retry budgets explicitly.
   */
  @Remote
  historySync(retry: boolean): void { this.history.sync(retry) }

  /**
   * Persist manual task assignments or an ignore decision.
   * @param request - complete task set and expected record revision.
   * @returns completion after commit.
   */
  @Remote
  historyRule(request: HistoryRule): Promise<void> { return this.history.rule(request) }

  /** Read retained code summaries without starting analysis.
   * @param from Inclusive timestamp or null.
   * @param to Exclusive timestamp or null.
   * @param offset Page offset.
   * @param taskId Optional task identity.
   * @returns Retained summaries and scan status.
   */
  @Remote
  codeList(from: string | null, to: string | null, offset: number, taskId?: string): CodePage {
    return this.code.list(from, to, offset, taskId)
  }

  /** Read archived code evidence.
   * @param id Identity returned by codeList.
   * @returns Retained record and patch-expiration status.
   */
  @Remote
  codeRead(id: CodeId): CodeRecord { return this.code.read(id) }

  /** Start a background code scan.
   * @param retry Whether to retry exhausted analysis failures.
   */
  @Remote
  codeSync(retry: boolean): void { void this.code.sync(retry) }

  /** Upload a task screenshot to durable native storage.
   * @param data Canonical base64 bytes.
   * @param mediaType Declared raster format.
   * @returns Versioned Markdown destination.
   */
  @Remote
  journalUploadImage(data: string, mediaType: string): Promise<string> {
    return this.journal.uploadImage(data, mediaType)
  }

  /** Load a retained task screenshot.
   * @param destination Saved Markdown destination.
   * @returns Verified raster data URL.
   */
  @Remote
  journalReadImage(destination: string): Promise<string> {
    return this.journal.readImage(destination)
  }

  private readonly taskContext: TaskContext

  /**
   * Prepare hidden task context without adding an empty conversation to the task.
   * @param sessionId - native conversation identity.
   * @param taskId - saved task identity.
   * @returns completion after durable context preparation.
   */
  @Remote
  async prepareTaskSession(sessionId: SessionId, taskId: JournalId): Promise<void> {
    await this.resumeConversation(sessionId)
    return this.taskContext.prepare(sessionId, taskId)
  }

  /** Prepare the selected week for a board conversation.
   * @param sessionId Native conversation identity.
   * @param week Selected week date.
   * @returns Completion after durable preparation.
   */
  @Remote
  async prepareBoardSession(sessionId: SessionId, week: string): Promise<void> {
    await this.resumeConversation(sessionId)
    return this.taskContext.prepareBoard(sessionId, week)
  }

  private async resumeConversation(sessionId: SessionId): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in result) throw new Error(result.error.message)
  }

  /** Save a native conversation's task update and association together.
   * @param session Native source conversation.
   * @param request Revision-checked change.
   * @param summary Task-specific conversation summary.
   * @returns Durable receipt.
   */
  recordConversationChange(session: Session, request: JournalWrite, summary: string): Promise<JournalEvent> {
    return this.taskContext.write(session, request, summary)
  }

  private polishing = 0
  private readonly briefPolicy: () => Config['briefPolish']

  /**
   * List registered models for the independent task editor settings.
   * @returns provider/model identities and display labels; no Agent is activated.
   */
  @Remote
  async polishModels(): Promise<{ provider: string; model: string; label: string }[]> {
    const groups = await Promise.all(this.ctx.llm.listProviders().map(async provider =>
      (await this.ctx.llm.listModels(provider.id)).map(model => ({
        provider: provider.id, model: model.id, label: `${provider.name} · ${model.name}`,
      }))))
    return groups.flat()
  }

  /**
   * Polish a submitted description through DSH without mutating the task or conversation.
   * @param request - exact user draft and native session for audit logging.
   * @returns validated section bodies; deadline, capacity and model failures reject.
   */
  @Remote
  journalPolish(request: BriefPolishRequest): Promise<PolishedBrief> {
    return this.runtime.operation(async (signal) => {
      if (this.polishing >= this.runtime.config.maxConcurrentRuns) throw new Error('Task editor is busy; retry shortly')
      this.polishing++
      try {
        return await polishBrief(this.ctx, this.briefPolicy(), request, signal)
      } finally {
        this.polishing--
      }
    })
  }

  /**
   * A bounded work-item page.
   * @param query - day and text filters.
   * @returns a bounded work-item page.
   */
  @Remote
  journalQuery(query: JournalQuery): JournalPage { return this.journal.query(query) }

  /**
   * Original work record.
   * @param id - cited receipt identity.
   * @returns original work record.
   */
  @Remote
  journalEvent(id: JournalId): JournalEvent { return this.journal.readEvent(id) }

  /**
   * Persisted change receipt.
   * @param request - revision-bound explicit edit.
   * @returns persisted change receipt.
   */
  @Remote
  journalWrite(request: JournalWrite): Promise<JournalEvent> { return this.journal.write(request) }

  /**
   * Historical receipts.
   * @param itemId - work identity.
   * @param offset - history cursor.
   * @returns historical receipts.
   */
  @Remote
  journalHistory(itemId: JournalId, offset: number): { events: JournalEvent[]; nextOffset: number | null } {
    return this.journal.history(itemId, offset)
  }

  /**
   * Dated changes and undo markers.
   * @param from - first day.
   * @param to - last day.
   * @param offset - activity cursor.
   * @returns dated changes and undo markers.
   */
  @Remote
  journalActivity(from: string, to: string, offset: number): {
    events: JournalEvent[]
    revertedIds: JournalId[]
    nextOffset: number | null
  } {
    return this.journal.activity(from, to, offset)
  }

  /**
   * Week facts for native dsh generation.
   * @param day - selected date.
   * @param offset - item cursor.
   * @returns week facts for native DSH generation.
   */
  @Remote
  journalWeek(day: string, offset: number): JournalWeek { return this.journal.week(day, offset) }

  /**
   * Saved personal retrospective and stale status.
   * @param day - selected date.
   * @returns saved personal retrospective and stale status.
   */
  @Remote
  journalReport(day: string): { report: JournalReport | null; stale: boolean } { return this.journal.report(day) }

  /**
   * Saved report version.
   * @param request - cited retrospective and expected version.
   * @returns saved report version.
   */
  @Remote
  journalSaveReport(request: JournalReportWrite): Promise<JournalReport> { return this.journal.saveReport(request) }

  /**
   * Read deployment scope and model settings without exposing credentials.
   * @returns project, scope and model settings without credentials.
   */
  @Remote
  describe(): Promise<WorkbenchInfo> {
    return this.runtime.operation(() => this.runtime.describe())
  }

  /**
   * Read the retained TAPD cache and its last refresh outcome.
   * @returns last successful personal TAPD cache and refresh error.
   */
  @Remote
  tapdSnapshot(): TapdCache {
    return this.runtime.tapdSnapshot()
  }

  /**
   * Refresh personal work items without starting a model.
   * @returns refreshed work items without starting a model.
   */
  @Remote
  refreshTapd(): Promise<TapdCache> {
    return this.runtime.refreshTapd()
  }

  /**
   * Read CrashSight Issues confirmed through TAPD-origin investigations.
   * @param query - text filter and page offset.
   * @returns locally confirmed TAPD-to-Issue associations without a broad provider search.
   */
  @Remote
  linkedCrashes(query: LinkedCrashQuery): LinkedCrashPage {
    return queryLinkedCrashes(this.runtime.store, query, this.runtime.config.pageSize)
  }

  /**
   * Query one Issue page within the configured application scope.
   *
   * @param query - app, platform, absolute interval and filters.
   * @returns one Issue page with total and scope.
   */
  @Remote
  searchIssues(query: CrashQuery): Promise<CrashPage> {
    return this.runtime.operation(signal => this.runtime.boards.issues(query, signal))
  }

  /**
   * Read concrete Reports while retaining the selected Issue filters.
   *
   * @param query - original Issue filter and Report offset.
   * @param issueId - selected Issue in that application.
   * @returns exact Reports for sample selection.
   */
  @Remote
  listReports(query: CrashQuery, issueId: string): Promise<ReportPage> {
    return this.runtime.operation(signal => this.runtime.boards.reports(query, issueId, signal))
  }

  /**
   * Read Issue details, trends and confirmed TAPD links.
   * @param query - frozen board filters.
   * @param issueId - selected Issue identity.
   * @returns fresh scoped details and source limitations.
   */
  @Remote
  issueDetails(query: CrashQuery, issueId: string): Promise<CrashDetails> { return this.runtime.issueDetails(query, issueId) }

  /**
   * Resolve a frozen evidence preview without starting analysis.
   *
   * @param request - target, samples and selected mode.
   * @returns frozen preview without starting Codex.
   */
  @Remote
  createPlan(request: PlanRequest): Promise<InvestigationPlan> {
    return this.runtime.createPlan(request)
  }

  /**
   * Admit a confirmed preview once and return its durable investigation.
   *
   * @param planId - displayed preview confirmed by Start.
   * @returns durable run, idempotently for that token.
   * @throws When overlapping active work has a different confirmed scope.
   */
  @Remote
  startInvestigation(planId: PlanId): Promise<RunRecord> {
    return this.runtime.startInvestigation(planId)
  }

  /**
   * Read one bounded page of shared investigation history.
   * @param query - source, text, mode, status and offset filters.
   * @returns matching compact rows and total.
   */
  @Remote
  listRuns(query: RunQuery): RunPage {
    return queryRuns(this.runtime.store, query, this.runtime.config.connectionId, this.runtime.config.pageSize)
  }

  /**
   * Look up the authoritative phase and result references of one investigation.
   *
   * @param id - investigation identity.
   * @returns durable phase, status and artifacts.
   */
  @Remote
  getRun(id: RunId): RunRecord {
    return this.runtime.getRun(id)
  }

  /**
   * Request cancellation and retain stopping until resource cleanup completes.
   *
   * @param id - investigation to stop.
   * @returns stopping until resource cleanup completes.
   */
  @Remote
  cancelInvestigation(id: RunId): Promise<RunRecord> {
    return this.runtime.cancelInvestigation(id)
  }

  /**
   * Read a committed report after identity, size and content-hash verification.
   *
   * @param id - completed investigation identity.
   * @returns verified Chinese Markdown report.
   */
  @Remote
  readReport(id: RunId): Promise<string> {
    return this.runtime.operation(async () => (await this.runtime.artifact(id, 'report')).toString('utf8'))
  }

  /**
   * Read current materials and bounded profile histories.
   * @param draftId - selected generation, or null for the first row.
   * @param draftOffset - generation history offset.
   * @param versionOffset - publication history offset.
   * @returns current publication, version headers and one draft body.
   */
  @Remote
  profileState(draftId: ProfileId | null, draftOffset: number, versionOffset: number): ProfileView {
    return queryProfile(this.runtime.store, draftId, draftOffset, versionOffset, this.runtime.config.pageSize)
  }

  /**
   * Poll small revision tokens and active execution indicators.
   * @returns changes without historical report or profile content.
   */
  @Remote
  changes(): WorkbenchChanges { return queryChanges(this.runtime.store) }

  /**
   * Load one immutable publication only when selected.
   * @param id - publication identity.
   * @returns its verified durable content.
   */
  @Remote
  getPublication(id: ProfileId): ProfilePublication {
    const publication = this.runtime.store.domain.table('publications').get(profileIdSchema.parse(id))
    if (!publication) throw new Error('Profile version was not found')
    return publication
  }

  /**
   * Load committed Case conclusions, evidence references and dual handoffs on demand.
   * @param id - completed investigation.
   * @returns hash-verified structured report.
   */
  @Remote
  readResult(id: RunId): Promise<InvestigationReportContent> {
    return this.runtime.operation(() => this.runtime.result(id))
  }

  /**
   * Read a bounded window of hash-verified Case evidence.
   * @param id - completed investigation.
   * @param evidenceId - file identity from the selected Case.
   * @param offset - byte offset, starting at zero.
   * @returns verified text and optional next offset.
   */
  @Remote
  readEvidence(id: RunId, evidenceId: string, offset: number): Promise<EvidencePreview> {
    return this.runtime.readEvidence(id, evidenceId, offset)
  }

  /**
   * Measure the feature's logical disk use and free capacity.
   * @returns owned file and record occupancy.
   */
  @Remote
  storageUsage(): Promise<StorageUsage> { return this.runtime.storageUsage() }

  /**
   * Preview deletions while protecting publications and evidence references.
   * @param includeHistory - include expired unreferenced investigations.
   * @returns exact candidates without deleting data.
   */
  @Remote
  previewCleanup(includeHistory: boolean): Promise<CleanupPreview> { return this.runtime.previewCleanup(includeHistory) }

  /**
   * Apply a still-current cleanup preview.
   * @param token - displayed preview digest.
   * @param includeHistory - same history scope as the preview.
   * @returns removals and remaining storage use.
   */
  @Remote
  cleanStorage(token: CleanupToken, includeHistory: boolean): Promise<CleanupResult> {
    return this.runtime.cleanStorage(token, includeHistory)
  }

  /**
   * Freeze fresh work evidence and its source coverage without invoking a model.
   * @returns new immutable materials without starting a model.
   */
  @Remote
  refreshEvidence(): Promise<PersonalProfileEvidenceSnapshot> {
    return this.runtime.refreshEvidence()
  }

  /**
   * Start a profile draft bound to the displayed immutable evidence.
   *
   * @param snapshotId - evidence displayed at generation time.
   * @returns running draft bound to that snapshot.
   */
  @Remote
  generateProfile(snapshotId: string): Promise<ProfileRecord> {
    return this.runtime.generateProfile(snapshotId)
  }

  /**
   * Stop profile generation and wait for its resources to be released.
   *
   * @param id - profile generation to stop.
   * @returns stopping until resource cleanup completes.
   */
  @Remote
  cancelProfile(id: ProfileRecord['id']): Promise<ProfileRecord> {
    return this.runtime.cancelProfile(id)
  }

  /**
   * Apply a human decision only to the expected unpublished draft revision.
   *
   * @param request - revision-bound claim review.
   * @returns updated unpublished draft.
   */
  @Remote
  reviewClaim(request: ReviewRequest): Promise<ProfileRecord> {
    return this.runtime.reviewClaim(request)
  }

  /**
   * Publish reviewed claims as an immutable version with a current pointer.
   *
   * @param request - reviewed generation and revision.
   * @returns immutable published version.
   */
  @Remote
  publishProfile(request: PublishRequest): Promise<ProfilePublication> {
    return this.runtime.publishProfile(request)
  }
}

/**
 * Open the domain, recover interrupted records and provide the Host service.
 * @param ctx - scoped plugin Context.
 * @param config - explicit deployment settings.
 * @returns disposer awaiting workers and reads before closing storage.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  if (!isAbsolute(config.dataRoot) || !isAbsolute(config.sourceRoot))
    throw new Error('Workbench data and source roots must be absolute')
  credentialRef(config.tapdTokenEnv)
  credentialRef(config.crashSightTokenEnv)
  new Intl.DateTimeFormat('en-CA', { timeZone: config.crashSightTimeZone })
  if (config.storage.maxRunBytes > config.storage.maxBytes || config.maxPreviewBytes > config.maxResultBytes)
    throw new Error('Workbench byte limits are inconsistent')
  await mkdir(config.dataRoot, { recursive: true })
  const store = await WorkbenchStore.open(ctx)
  const records = await PersonalRecords.open(ctx)
  let journal: WorkJournal | undefined
  let history: ConversationHistory | undefined
  let code: CodeHistory | undefined
  let reviews: Reviews | undefined
  try {
    journal = await WorkJournal.open(ctx, config.pageSize, config.maxResultBytes,
      new TaskImages(join(config.dataRoot, 'task-images'), ctx.attachments, config.storage.imageRetentionDays * 86_400_000))
    await store.recover()
    const runtime = new WorkbenchRuntime(ctx, config, store)
    await runtime.storage.recover()
    await runtime.restoreLegacyLinks()
    ctx.effect(() => ctx.jobs.attachController('personal-workbench'), 'Personal workbench job controller')
    history = await ConversationHistory.open(ctx, config, journal)
    code = await CodeHistory.open(ctx, config, journal)
    const ownedHistory = history
    const ownedCode = code
    const ownedJournal = journal
    reviews = await Reviews.open(ctx, config, (from, to, zone) => reviewInputs(ownedHistory, ownedCode, ownedJournal, from, to, zone))
    new PersonalWorkbench(ctx, runtime, journal, history, code, reviews)
    reviews.start()
    code.start()
    history.start()
    runtime.startMaintenance(() => ownedJournal.collectImages())
    const ownedReviews = reviews
    return async () => { await ownedReviews.close(); await ownedCode.close(); await ownedHistory.close(); await runtime.close(); await ownedJournal.close(); await records.close() }
  } catch (error) {
    await reviews?.close()
    await code?.close()
    await history?.close()
    await journal?.close()
    await store.close()
    await records.close()
    throw error
  }
}
