import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { enrichDossierWithAttachments } from '../src/incident/evidence-store.ts'
import { evidenceDossierSchema } from '../src/incident/schema.ts'
import { RunBudget } from '../src/storage.ts'
import { harness } from './helpers.ts'

describe('attachment cleanup', () => {
  it('removes earlier extracted files when a later archive entry exceeds the configured limit', async () => {
    const h = await harness()
    const zip = await readFile(new URL('./fixtures/two-logs.zip', import.meta.url))
    const url = 'https://evidence.example.test/two-logs.zip'
    const original = globalThis.fetch
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input, init) =>
        (input instanceof Request ? input.url : input.toString()) === url
          ? Promise.resolve(new Response(zip, { status: 200 }))
          : original(input, init),
      )
    try {
      const dossier = evidenceDossierSchema.parse({
        ticket: null,
        classification: { kind: 'crash', confidence: 1, rationale: 'fixture' },
        scope: 'fixture',
        provenance: { tapdTools: [], crashSightTools: [], failedToolCalls: [] },
        humanContext: null,
        evidenceRoot: null,
        symptoms: [],
        reproductionSteps: [],
        evidenceItems: [],
        cases: [],
        missingEvidence: [],
        binaryArtifacts: [],
        attachmentArtifacts: [],
        collectionErrors: [],
        collectionNotes: [],
        attachmentCandidates: [
          {
            id: 'logs',
            caseId: null,
            evidenceRef: 'attachment:logs',
            attachmentId: 'logs',
            name: 'logs.zip',
            contentType: 'application/zip',
            kind: 'log_archive',
          },
        ],
      })
      const result = await enrichDossierWithAttachments({
        dossier,
        attachmentDownloadUrls: new Map([['logs', url]]),
        evidenceStoreRoot: h.root,
        workflowRunId: 'fixture',
        limits: { ...h.config.evidenceLimits, maxArchiveEntries: 1 },
        budget: new RunBudget(h.config.storage.maxRunBytes, 0),
        signal: new AbortController().signal,
      })
      expect(result.attachmentArtifacts[0]?.status).toBe('failed')
      expect(result.attachmentArtifacts[0]?.error).toContain('more than 1 entries')
      expect(result.attachmentArtifacts[0]?.textFiles).toEqual([])
      expect((await stat(join(h.root, 'fixture', 'cases', 'shared', 'logs', 'raw', 'logs.zip'))).size).toBe(zip.length)
      await expect(stat(join(h.root, 'fixture', 'cases', 'shared', 'logs', 'text'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      fetch.mockRestore()
      await h.close()
    }
  })
})
