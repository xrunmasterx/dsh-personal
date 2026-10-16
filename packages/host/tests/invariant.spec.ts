import { randomUUID } from 'node:crypto'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Invariants from '@deepseek-ai/dsh-invariants'
import { expect, it, vi } from 'vitest'
import { WorkbenchBoards } from '../src/boards.ts'
import { PersonalWorkbench } from '../src/index.ts'
import { ConversationHistory } from '../src/history.ts'
import { CodeHistory } from '../src/code-history.ts'
import { Reviews } from '../src/reviews.ts'
import { WorkJournal } from '../src/journal.ts'
import * as Companion from '../src/invariant.ts'
import { profileIdSchema } from '../src/models.ts'
import { buildPersonalProfileContent } from '../src/profile/rules.ts'
import { WorkbenchRuntime } from '../src/runtime.ts'
import { aiDraft, evidenceSnapshot, harness } from './helpers.ts'

async function setup() {
  const h = await harness()
  await h.ctx.plugin(SystemPrompt)
  const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, {
    boards: new WorkbenchBoards(h.config, { resolve: async () => undefined }), execute: vi.fn(),
  })
  const journal = await WorkJournal.open(h.ctx, h.config.pageSize, h.config.maxResultBytes)
  const history = await ConversationHistory.open(h.ctx, h.config, journal)
  const code = await CodeHistory.open(h.ctx, h.config, journal)
  const reviews = await Reviews.open(h.ctx, h.config, () => ({ sources: [], errors: [], tasks: [] }))
  new PersonalWorkbench(h.ctx, runtime, journal, history, code, reviews)
  await h.ctx.plugin(Invariants, { enabled: true })
  await h.ctx.plugin(Companion)
  return { ...h, runtime, async close() { await reviews.close(); await code.close(); await history.close(); await journal.close(); await h.close() } }
}

it('accepts a reviewed publication and diagnoses a later overwrite of that immutable version', async () => {
  const h = await setup()
  try {
    const evidence = evidenceSnapshot()
    const content = buildPersonalProfileContent({ evidenceSnapshot: evidence, previousPublished: null, rejectedClaims: [] },
      aiDraft, new Date(evidence.createdAt))
    const id = profileIdSchema.parse(randomUUID())
    await h.store.domain.table('evidence').put(evidence.id, evidence)
    await h.store.domain.table('profiles').put(id, {
      id, snapshotId: evidence.id, content, revision: 1, status: 'completed', createdAt: evidence.createdAt,
      updatedAt: evidence.createdAt, error: null,
    })
    const claim = content.claims[0]
    if (!claim) throw new Error('Fixture draft has no ordinary claim')
    const reviewed = await h.runtime.reviewClaim({ generationId: id, expectedRevision: 1,
      claimId: claim.id, action: 'confirm', correction: '' })
    const publication = await h.runtime.publishProfile({ generationId: id, expectedRevision: reviewed.revision })
    expect(h.runtime.profileState().published?.id).toBe(publication.id)
    const changed = {
      ...publication, content: { ...publication.content, summary: 'Unexpected overwrite' },
    }
    await h.store.domain.table('publications').put(publication.id, changed)
    // The domain contains observer failures after committing; direct dispatch exposes the diagnostic.
    expect(() =>{  h.ctx.emit('domain/changed', { domain: 'personal_workbench', table: 'publications',
      key: publication.id, operation: 'put', value: changed }) }).toThrow(/published version changed/)
  } finally { await h.runtime.close(); await h.close() }
})

it('diagnoses a durable current pointer whose publication does not exist', async () => {
  const h = await setup()
  try {
    const invalid = {
      publishedId: profileIdSchema.parse(randomUUID()), evidenceId: null,
    }
    await h.store.domain.table('control').put('current', invalid)
    expect(() =>{  h.ctx.emit('domain/changed', { domain: 'personal_workbench', table: 'control',
      key: 'current', operation: 'put', value: invalid }) }).toThrow(/publication pointer has no publication/)
  } finally { await h.runtime.close(); await h.close() }
})
