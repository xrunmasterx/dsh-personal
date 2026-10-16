/** Publication referential integrity and immutability over committed workbench records. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type {} from './index.ts'
import type { ProfileId } from './models.ts'

/** Cordis companion plugin name. */
export const name = 'personal-workbench-invariant'
/** Registry owning the companion's lifetime. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const domain = ctx.personalWorkbench.runtime.store.domain
  const fixedPublications = new Map<ProfileId, string>()
  const fixedDrafts = new Map<ProfileId, string>()
  const verify = () => {
    const current = domain.table('control').get('current')
    if (!current) fail('the current control record is missing')
    if (current.publishedId && !domain.table('publications').get(current.publishedId)) {
      fail('the current publication pointer has no publication')
    }
    if (current.evidenceId && !domain.table('evidence').get(current.evidenceId)) {
      fail('the current evidence pointer has no snapshot')
    }
    const versions = new Set<number>()
    for (const [id, publication] of domain.table('publications').entries()) {
      const draft = domain.table('profiles').get(publication.generationId)
      if (!draft?.content) fail('a publication has no completed source draft')
      if (!domain.table('evidence').get(draft.snapshotId)) fail('a published draft has no evidence snapshot')
      if (versions.has(publication.version)) fail('two publications have the same version number')
      versions.add(publication.version)
      const evidence = new Set(publication.content.evidence.map(item => item.id))
      for (const claim of publication.content.claims) {
        if (claim.reviewStatus !== 'confirmed') fail('a publication includes an unconfirmed claim')
        if (claim.evidenceRefs.some(ref => !evidence.has(ref))) fail('a published claim has an unknown evidence reference')
      }
      const serialized = JSON.stringify(publication)
      const previous = fixedPublications.get(id)
      if (previous !== undefined && previous !== serialized) fail('a published version changed')
      fixedPublications.set(id, serialized)
      const serializedDraft = JSON.stringify(draft)
      const previousDraft = fixedDrafts.get(draft.id)
      if (previousDraft !== undefined && previousDraft !== serializedDraft) fail('a published source draft changed')
      fixedDrafts.set(draft.id, serializedDraft)
    }
    for (const id of fixedPublications.keys()) {
      if (!domain.table('publications').get(id)) {
        fail('a published version was deleted')
      }
    }
  }
  verify()
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'domain/changed') return
    const [change] = args as [DomainChanged]
    if (change.domain === 'personal_workbench') verify()
  }, { global: true })
}, { inject: ['personalWorkbench'] })

/** Register checks over the actual durable records and their change stream. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@xrunmasterx/dsh-personal-host', install))
