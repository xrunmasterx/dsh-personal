/** React-free Remote data owner; snapshots are read through the renderer's hooks compartment. */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  CrashPage,
  CrashQuery,
  InvestigationPlan,
  PlanId,
  PlanRequest,
  ProfileView,
  ProfilePublication,
  ProfileId,
  PublishRequest,
  ReportPage,
  ReviewRequest,
  RunId,
  RunRecord,
  TapdCache,
  WorkbenchInfo,
  RunPage,
  RunQuery,
  RunSummary,
  WorkbenchChanges,
  InvestigationReportContent,
  CrashDetails,
  EvidencePreview,
  StorageUsage,
  CleanupPreview,
  CleanupResult,
  CleanupToken,
  LinkedCrashPage,
  LinkedCrashQuery,
} from '@xrunmasterx/dsh-personal-api/client'
import type { WorkbenchPage } from './view-store.ts'
import type { ReviewWeek, ReviewEdit, ReviewSource, ReviewSourceId } from '@xrunmasterx/dsh-personal-host/client'
import type { BriefPolishRequest, PolishedBrief, JournalId, JournalQuery, JournalWrite, JournalReportWrite, JournalPage, JournalEvent, JournalWeek, JournalReport } from '@xrunmasterx/dsh-personal-host/client'

/** Host data shown by the workbench, separate from the root entry's navigation state. */
export interface WorkbenchData {
  info: WorkbenchInfo | null
  tapd: TapdCache | null
  runs: RunSummary[]
  runPage: RunPage | null
  selectedRun: RunRecord | null
  profile: ProfileView | null
  publication: ProfilePublication | null
  changes: WorkbenchChanges | null
  issueDetails: CrashDetails | null
  result: { runId: RunId; content: InvestigationReportContent } | null
  evidence: { runId: RunId; preview: EvidencePreview } | null
  storage: StorageUsage | null
  cleanup: CleanupPreview | null
  cleaned: CleanupResult | null
  issues: CrashPage | null
  reports: ReportPage | null
  linkedCrashes: LinkedCrashPage | null
  plan: InvestigationPlan | null
  report: { runId: RunId; markdown: string } | null
  busy: string[]
  error: string | null
}

async function value<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Browser data owner; its disposal stops polling without canceling Host jobs. */
export class WorkbenchClient {
  /** Read a retained calendar week.
   * @param day Date within the week.
   * @returns Daily and weekly reviews.
   */
  reviewRead(day: string): Promise<ReviewWeek> { return value(this.remote.reviewRead(day)) }
  /** Queue a week for backfill or retry.
   * @param day Date within the week.
   * @returns Queue acknowledgement.
   */
  reviewSync(day: string): Promise<void> { return value(this.remote.reviewSync(day)) }
  /** Save a human correction.
   * @param request Revision-checked edit.
   * @returns Write acknowledgement.
   */
  reviewEdit(request: ReviewEdit): Promise<void> { return value(this.remote.reviewEdit(request)) }
  /** Read cited evidence.
   * @param id Source identity.
   * @returns Retained source snapshot.
   */
  reviewSource(id: ReviewSourceId): Promise<ReviewSource> { return value(this.remote.reviewSource(id)) }
  /**
   * Observable browser projection and foreground operation state.
   */
  readonly data = createSnapshotStore<WorkbenchData>({
    info: null,
    tapd: null,
    runs: [],
    runPage: null,
    selectedRun: null,
    profile: null,
    publication: null,
    changes: null,
    issueDetails: null,
    result: null,
    evidence: null,
    storage: null,
    cleanup: null,
    cleaned: null,
    issues: null,
    reports: null,
    linkedCrashes: null,
    plan: null,
    report: null,
    busy: [],
    error: null,
  })
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private queryRevision = 0
  private reportRevision = 0
  private reportReadRevision = 0
  private planRevision = 0
  private runRevision = 0
  private detailRevision = 0
  private evidenceRevision = 0
  private historyRevision = 0
  private profileRevision = 0
  private versionRevision = 0
  private readonly pending = new Map<string, number>()
  private page: WorkbenchPage = 'tapd'
  private revisions: Record<string, string> = {}
  private runQuery: RunQuery = { offset: 0, target: null, text: '', mode: 'all', status: 'all' }
  private draftId: ProfileId | null = null
  private draftOffset = 0
  private versionOffset = 0
  private linkedCrashQuery: LinkedCrashQuery = { offset: 0, text: '' }
  private linkedCrashRevision = 0

  constructor(private readonly remote: ClientRemote['personalWorkbench']) {}

  /**
   * One journal page.
   * @param query - day filters and cursor.
   * @returns one journal page.
   */
  journalQuery(query: JournalQuery): Promise<JournalPage> { return value(this.remote.journalQuery(query)) }
  /** Store a task screenshot.
   * @param data Base64 bytes.
   * @param mediaType Raster format.
   * @returns Durable Markdown destination.
   */
  journalUploadImage(data: string, mediaType: string): Promise<string> { return value(this.remote.journalUploadImage(data, mediaType)) }
  /** Load a task screenshot.
   * @param destination Durable Markdown destination.
   * @returns Display-only raster data URL.
   */
  journalReadImage(destination: string): Promise<string> { return value(this.remote.journalReadImage(destination)) }
  /**
   * Polish a draft without saving it.
   * @param request - user draft and native session for audit logging.
   * @returns validated section bodies; model and capacity failures reject.
   */
  journalPolish(request: BriefPolishRequest): Promise<PolishedBrief> { return value(this.remote.journalPolish(request)) }

  /**
   * Original work record.
   * @param id - cited receipt.
   * @returns original work record.
   */
  journalEvent(id: JournalId): Promise<JournalEvent> { return value(this.remote.journalEvent(id)) }
  /**
   * Persisted receipt.
   * @param request - explicit edit.
   * @returns persisted receipt.
   */
  journalWrite(request: JournalWrite): Promise<JournalEvent> { return value(this.remote.journalWrite(request)) }
  /**
   * Immutable history.
   * @param id - work identity.
   * @param offset - cursor.
   * @returns immutable history.
   */
  journalHistory(id: JournalId, offset: number): Promise<{
    events: JournalEvent[]
    nextOffset: number | null
  }> {
    return value(this.remote.journalHistory(id, offset))
  }
  /**
   * Dated activity.
   * @param from - first day.
   * @param to - last day.
   * @param offset - cursor.
   * @returns dated activity.
   */
  journalActivity(from: string, to: string, offset: number): Promise<{
    events: JournalEvent[]
    revertedIds: JournalId[]
    nextOffset: number | null
  }> {
    return value(this.remote.journalActivity(from, to, offset))
  }
  /**
   * Retrospective evidence.
   * @param day - selected day.
   * @param offset - cursor.
   * @returns retrospective evidence.
   */
  journalWeek(day: string, offset: number): Promise<JournalWeek> { return value(this.remote.journalWeek(day, offset)) }
  /**
   * Saved retrospective.
   * @param day - selected day.
   * @returns saved retrospective.
   */
  journalReport(day: string): Promise<{ report: JournalReport | null; stale: boolean }> { return value(this.remote.journalReport(day)) }
  /**
   * Saved version.
   * @param request - cited edit and revision.
   * @returns saved version.
   */
  journalSaveReport(request: JournalReportWrite): Promise<JournalReport> { return value(this.remote.journalSaveReport(request)) }

  /** Read local Host state and begin bounded polling after configuration is available. */
  async initialize(): Promise<void> {
    await this.action('load', async () => {
      const info = await value(this.remote.describe())
      if (this.closed) return
      this.data.update((data) => {
        data.info = info
      })
      await this.refreshBase(true)
    })
    this.schedule()
  }

  /** Stop browser subscriptions while admitted Host work continues independently. */
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
  }

  /**
   * Reload Host state while keeping an in-flight foreground error visible.
   * @returns current local records after a manual refresh.
   */
  refresh(): Promise<void | undefined> {
    return this.data.getSnapshot().info ? this.action('load', () => this.refreshBase(true)) : this.initialize()
  }

  /**
   * Load only the visible page; navigation to chat suspends business polling.
   * @param page - current workbench destination.
   */
  activate(page: WorkbenchPage): void {
    this.page = page
    if (this.data.getSnapshot().info && !this.journalPage() && page !== 'chat')
      void this.action(`navigate:${page}`, () => this.refreshBase(true))
    this.schedule()
  }

  /**
   * Load a bounded investigation history page with server-side filters.
   * @param query - current source and history filters.
   * @returns completion of the selected history page.
   */
  loadRuns(query: RunQuery): Promise<void | undefined> {
    this.runQuery = query
    const revision = ++this.historyRevision
    this.runRevision++
    this.data.update((data) => {
      data.selectedRun = null
    })
    return this.action(
      'runs',
      async () => {
        const page = await value(this.remote.listRuns(query))
        if (!this.closed && revision === this.historyRevision)
          this.data.update((data) => {
            data.runs = page.items
            data.runPage = page
          })
      },
      () => revision === this.historyRevision,
    )
  }

  /**
   * Select a full investigation without retaining every run's large context.
   * @param id - investigation to inspect.
   * @returns completion of its detail read.
   */
  readRun(id: RunId): Promise<void | undefined> {
    const revision = ++this.runRevision
    this.data.update((data) => {
      data.selectedRun = null
      data.result = null
      data.report = null
      data.evidence = null
    })
    return this.action(
      'run',
      async () => {
        const run = await value(this.remote.getRun(id))
        if (!this.closed && revision === this.runRevision)
          this.data.update((data) => {
            data.selectedRun = run
          })
      },
      () => revision === this.runRevision,
    )
  }

  /**
   * Read a fresh Issue summary and trend without resolving a new investigation sample.
   * @param query - frozen board filters.
   * @param issueId - selected Issue.
   * @returns completion of its details.
   */
  inspectIssue(query: CrashQuery, issueId: string): Promise<void | undefined> {
    const revision = ++this.detailRevision
    this.data.update((data) => {
      data.issueDetails = null
    })
    return this.action(
      'issue',
      async () => {
        const detail = await value(this.remote.issueDetails(query, issueId))
        if (!this.closed && revision === this.detailRevision)
          this.data.update((data) => {
            data.issueDetails = detail
          })
      },
      () => revision === this.detailRevision,
    )
  }

  /** Close the pinned Issue detail and allow rolling-window refresh again. */
  closeIssue(): void {
    this.detailRevision++
    this.data.update((data) => {
      data.issueDetails = null
    })
  }

  /**
   * Load one verified evidence window on demand.
   * @param id - completed investigation.
   * @param evidenceId - selected Case file identity.
   * @param offset - next byte position, starting at zero.
   * @returns completion of the verified preview.
   */
  readEvidence(id: RunId, evidenceId: string, offset: number): Promise<void | undefined> {
    const revision = ++this.evidenceRevision
    return this.action(
      'file',
      async () => {
        const preview = await value(this.remote.readEvidence(id, evidenceId, offset))
        if (!this.closed && revision === this.evidenceRevision)
          this.data.update((data) => {
            data.evidence = { runId: id, preview }
          })
      },
      () => revision === this.evidenceRevision,
    )
  }

  /**
   * Load one draft body and a bounded history page.
   * @param id - selected generation, or null for the first row.
   * @param draftOffset - generation page offset.
   * @param versionOffset - publication page offset.
   * @returns completion of profile loading.
   */
  loadProfile(id: ProfileId | null, draftOffset: number, versionOffset: number): Promise<void | undefined> {
    const revision = ++this.profileRevision
    this.draftId = id
    this.draftOffset = draftOffset
    this.versionOffset = versionOffset
    return this.action(
      'profile',
      async () => {
        const profile = await value(this.remote.profileState(id, draftOffset, versionOffset))
        if (!this.closed && revision === this.profileRevision)
          this.data.update((data) => {
            data.profile = profile
          })
      },
      () => revision === this.profileRevision,
    )
  }

  /**
   * Fetch one immutable historical profile only when opened.
   * @param id - publication identity.
   * @returns completion of the version read.
   */
  readVersion(id: ProfileId): Promise<void | undefined> {
    const revision = ++this.versionRevision
    return this.action(
      'version',
      async () => {
        const publication = await value(this.remote.getPublication(id))
        if (!this.closed && revision === this.versionRevision)
          this.data.update((data) => {
            data.publication = publication
          })
      },
      () => revision === this.versionRevision,
    )
  }

  /**
   * Measure disk usage and prepare a reviewable cleanup set.
   * @param includeHistory - include expired unreferenced investigation history.
   * @returns completion without deleting data.
   */
  previewCleanup(includeHistory: boolean): Promise<void | undefined> {
    return this.action('cleanup-preview', async () => {
      const cleanup = await value(this.remote.previewCleanup(includeHistory))
      if (!this.closed)
        this.data.update((data) => {
          data.cleanup = cleanup
          data.storage = cleanup.usage
          data.cleaned = null
        })
    })
  }

  /**
   * Apply the still-current set displayed in the cleanup preview.
   * @param token - exact displayed preview token.
   * @param includeHistory - its displayed history policy.
   * @returns completed deletion facts and refreshed storage use.
   */
  cleanStorage(token: CleanupToken, includeHistory: boolean): Promise<void | undefined> {
    return this.action('cleanup', async () => {
      const cleaned = await value(this.remote.cleanStorage(token, includeHistory))
      if (!this.closed)
        this.data.update((data) => {
          data.cleaned = cleaned
          data.storage = cleaned.usage
          data.cleanup = null
        })
      await this.refreshBase(true)
    })
  }

  /**
   * Refresh personal work items without starting a model.
   * @returns refreshed personal work items without a model request.
   */
  refreshTapd(): Promise<void | undefined> {
    return this.action('tapd', async () => {
      const tapd = await value(this.remote.refreshTapd())
      if (!this.closed)
        this.data.update((data) => {
          data.tapd = tapd
        })
    })
  }

  /**
   * Load CrashSight associations already confirmed from TAPD evidence.
   * @param query - current text filter and page offset.
   * @returns completion of the bounded local projection.
   */
  loadLinkedCrashes(query: LinkedCrashQuery): Promise<void | undefined> {
    this.linkedCrashQuery = query
    const revision = ++this.linkedCrashRevision
    return this.action(
      'linked-crashes',
      async () => {
        const page = await value(this.remote.linkedCrashes(query))
        if (!this.closed && revision === this.linkedCrashRevision)
          this.data.update((data) => {
            data.linkedCrashes = page
          })
      },
      () => revision === this.linkedCrashRevision,
    )
  }

  /**
   * Query Issues and discard completions from older query generations.
   *
   * @param query - complete frozen query for this page.
   * @returns completion; old query responses cannot replace a newer result.
   */
  search(query: CrashQuery): Promise<void | undefined> {
    const revision = ++this.queryRevision
    this.detailRevision++
    this.reportRevision++
    this.data.update((data) => {
      data.reports = null
      data.issueDetails = null
    })
    return this.action(
      'issues',
      async () => {
        const page = await value(this.remote.searchIssues(query))
        if (!this.closed && revision === this.queryRevision)
          this.data.update((data) => {
            data.issues = page
          })
      },
      () => revision === this.queryRevision,
    )
  }

  /**
   * Read an Issue’s Reports without accepting results from a superseded query.
   *
   * @param query - exact filters from the currently displayed Issue page.
   * @param issueId - selected Issue.
   * @returns completion of the selected Report page.
   */
  reports(query: CrashQuery, issueId: string): Promise<void | undefined> {
    const revision = ++this.reportRevision
    this.data.update((data) => {
      data.reports = null
    })
    return this.action(
      'reports',
      async () => {
        const reports = await value(this.remote.listReports(query, issueId))
        if (!this.closed && revision === this.reportRevision)
          this.data.update((data) => {
            data.reports = reports
          })
      },
      () => revision === this.reportRevision,
    )
  }

  /**
   * Prepare a frozen preview that cannot reopen after its dialog is closed.
   *
   * @param request - mode and samples chosen in the investigation dialog.
   * @returns a preview without starting Codex.
   */
  prepare(request: PlanRequest): Promise<InvestigationPlan | undefined> {
    if (this.data.getSnapshot().busy.includes('plan')) return Promise.resolve(undefined)
    const revision = ++this.planRevision
    this.data.update((data) => {
      data.plan = null
    })
    return this.action('plan', async () => {
      const plan = await value(this.remote.createPlan(request))
      if (!this.closed && revision === this.planRevision)
        this.data.update((data) => {
          data.plan = plan
        })
      return plan
    })
  }

  /** Remove an unsubmitted dialog's transient plan. */
  clearPlan(): void {
    this.planRevision++
    this.data.update((data) => {
      data.plan = null
    })
  }

  /** Close sample selection and allow the recent Issue window to refresh again. */
  closeReports(): void {
    this.reportRevision++
    this.data.update((data) => {
      data.reports = null
    })
  }

  /**
   * Start the confirmed preview and refresh durable history.
   *
   * @param id - displayed preview confirmed by the user.
   * @returns admitted investigation identity.
   */
  start(id: PlanId): Promise<RunRecord | undefined> {
    return this.action('start', async () => {
      const run = await value(this.remote.startInvestigation(id))
      this.clearPlan()
      await this.refreshBase()
      return run
    })
  }

  /**
   * Request investigation cancellation without treating stopping as terminal.
   *
   * @param id - live investigation.
   * @returns refreshed local records after requesting cancellation.
   */
  cancel(id: RunId): Promise<void | undefined> {
    return this.action('cancel', async () => {
      await value(this.remote.cancelInvestigation(id))
      await this.refreshBase()
    })
  }

  /**
   * Read a committed report after identity, size and content-hash verification.
   *
   * @param id - completed investigation.
   * @returns verified report text.
   */
  readReport(id: RunId): Promise<void | undefined> {
    const revision = ++this.reportReadRevision
    const runRevision = this.runRevision
    const current = () => revision === this.reportReadRevision && runRevision === this.runRevision
    return this.action(
      'report',
      async () => {
        const markdown = await value(this.remote.readReport(id))
        const run = this.data.getSnapshot().selectedRun
        const content =
          run?.id === id && run.artifacts.some(file => file.id === 'result')
            ? await value(this.remote.readResult(id))
            : null
        if (!this.closed && current())
          this.data.update((data) => {
            data.report = { runId: id, markdown }
            data.result = content ? { runId: id, content } : null
          })
      },
      current,
    )
  }

  /**
   * Freeze fresh work evidence and its source coverage without invoking a model.
   * @returns refreshed immutable profile evidence without calling Codex.
   */
  refreshEvidence(): Promise<void | undefined> {
    return this.action('evidence', async () => {
      await value(this.remote.refreshEvidence())
      await this.refreshBase()
    })
  }

  /**
   * Start a draft from the displayed evidence snapshot.
   *
   * @param snapshotId - material revision displayed when generation starts.
   * @returns refreshed generation state.
   */
  generate(snapshotId: string): Promise<void | undefined> {
    return this.action('generate', async () => {
      const draft = await value(this.remote.generateProfile(snapshotId))
      this.draftId = draft.id
      this.draftOffset = 0
      await this.refreshBase(true)
    })
  }

  /**
   * Stop profile generation and wait for its resources to be released.
   *
   * @param id - running profile generation.
   * @returns refreshed state after requesting process cleanup.
   */
  cancelProfile(id: ProfileView['drafts'][number]['id']): Promise<void | undefined> {
    return this.action('cancel-profile', async () => {
      await value(this.remote.cancelProfile(id))
      await this.refreshBase()
    })
  }

  /**
   * Apply a revision-bound claim decision and reload the draft.
   *
   * @param request - displayed claim and draft revision.
   * @returns refreshed draft after human review.
   */
  review(request: ReviewRequest): Promise<void | undefined> {
    return this.action('review', async () => {
      await value(this.remote.reviewClaim(request))
      await this.refreshBase()
    })
  }

  /**
   * Publish the displayed reviewed revision and refresh its immutable history.
   *
   * @param request - reviewed draft revision.
   * @returns refreshed immutable publication state.
   */
  publish(request: PublishRequest): Promise<void | undefined> {
    return this.action('publish', async () => {
      await value(this.remote.publishProfile(request))
      await this.refreshBase()
    })
  }

  private async refreshBase(force = false): Promise<void> {
    if (this.page === 'chat' || this.journalPage()) return
    const changes = await value(this.remote.changes())
    const changed = (tables: string[]) =>
      force || tables.some(table => this.revisions[table] !== changes.revisions[table])
    const seen = (tables: string[]) => {
      for (const [table, revision] of Object.entries(changes.revisions))
        if (tables.includes(table)) this.revisions[table] = revision
    }
    if (this.closed) return
    this.data.update((data) => {
      data.changes = changes
      for (const activity of changes.activeProfiles) {
        const draft = data.profile?.drafts.find(draft => draft.id === activity.id)
        if (draft) draft.activity = activity.activity ?? undefined
      }
    })
    if (this.page === 'tapd' && changed(['tapd'])) {
      const tapd = await value(this.remote.tapdSnapshot())
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed)
        this.data.update((data) => {
          data.tapd = tapd
        })
      seen(['tapd'])
    }
    if (this.page === 'runs') {
      if (changed(['runs'])) {
        const revision = this.historyRevision
        const page = await value(this.remote.listRuns(this.runQuery))
        // Disposal may run while the Remote request is awaited.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.closed && revision === this.historyRevision) {
          this.data.update((data) => {
            data.runs = page.items
            data.runPage = page
          })
          seen(['runs'])
        }
      }
      const selected = this.data.getSnapshot().selectedRun
      if (selected && (force || ['queued', 'running', 'stopping'].includes(selected.status))) {
        const run = await value(this.remote.getRun(selected.id))
        // Disposal may run while the Remote request is awaited.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.closed && this.data.getSnapshot().selectedRun?.id === selected.id)
          this.data.update((data) => {
            data.selectedRun = run
          })
      }
    }
    if (this.page === 'crash' && changed(['runs', 'tapd'])) {
      const revision = this.linkedCrashRevision
      const page = await value(this.remote.linkedCrashes(this.linkedCrashQuery))
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed && revision === this.linkedCrashRevision) {
        this.data.update((data) => {
          data.linkedCrashes = page
        })
        seen(['runs', 'tapd'])
      }
    }
    if (this.page === 'profile' && changed(['profiles', 'publications', 'control', 'evidence'])) {
      const revision = this.profileRevision
      const profile = await value(this.remote.profileState(this.draftId, this.draftOffset, this.versionOffset))
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed && revision === this.profileRevision) {
        this.data.update((data) => {
          data.profile = profile
        })
        seen(['profiles', 'publications', 'control', 'evidence'])
      }
    }
    if (this.page === 'storage' && force) {
      const storage = await value(this.remote.storageUsage())
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed)
        this.data.update((data) => {
          data.storage = storage
        })
    }
    const snapshot = this.data.getSnapshot()
    const issues = snapshot.issues
    if (
      this.page === 'crash' &&
      issues?.query.rollingDays &&
      issues.query.offset === 0 &&
      !snapshot.reports &&
      !snapshot.issueDetails &&
      Date.now() - Date.parse(issues.fetchedAt) >= (snapshot.info?.cacheTtlMs ?? Infinity)
    ) {
      const to = Date.now()
      await this.search({ ...issues.query, to, from: to - issues.query.rollingDays * 86_400_000, offset: 0 })
    }
  }

  private async action<T>(name: string, operation: () => Promise<T>, current?: () => boolean): Promise<T | undefined> {
    if (this.closed || (this.pending.has(name) && !current)) return
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1)
    this.data.update((data) => {
      if (!data.busy.includes(name)) data.busy.push(name)
      if (name !== 'poll') data.error = null
    })
    try {
      return await operation()
    } catch (error) {
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed && (!current || current()))
        this.data.update((data) => {
          data.error = error instanceof Error ? error.message : String(error)
        })
      return undefined
    } finally {
      const remaining = (this.pending.get(name) ?? 1) - 1
      if (remaining) this.pending.set(name, remaining)
      else this.pending.delete(name)
      // Disposal may run while the Remote request is awaited.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!this.closed && !remaining)
        this.data.update((data) => {
          data.busy = data.busy.filter(item => item !== name)
        })
      if (name !== 'poll') this.schedule()
    }
  }

  private journalPage(): boolean {
    return this.page === 'board' || this.page === 'reflection'
  }

  private schedule(): void {
    clearTimeout(this.timer)
    const snapshot = this.data.getSnapshot()
    const active = Boolean(snapshot.changes?.activeRuns.length || snapshot.changes?.activeProfiles.length)
    const interval = active ? snapshot.info?.pollIntervalMs : snapshot.info?.idlePollIntervalMs
    if (this.closed || !interval || this.page === 'chat' || this.journalPage()) return
    this.timer = setTimeout(() => {
      void this.action('poll', () => this.refreshBase()).finally(() => {
        this.schedule()
      })
    }, interval)
  }
}
