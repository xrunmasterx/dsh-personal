import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { WorkbenchBoards } from '../src/boards.ts'
import { importLegacy } from '../src/migration.ts'
import { WorkbenchRuntime } from '../src/runtime.ts'
import { harness, tapdUrl } from './helpers.ts'

it('imports committed WAL records once and exposes byte-identical legacy reports through the runtime', async () => {
  const h = await harness()
  const source = join(h.root, 'old-workflow')
  const evidence = join(source, '.incident-evidence', 'legacy-run')
  await mkdir(evidence, { recursive: true })
  const report = Buffer.from('# 原调查报告\r\n\r\n保留原始结论。\r\n')
  await writeFile(join(evidence, 'report.md'), report)
  await writeFile(join(evidence, 'attachment.bin'), new Uint8Array([0, 255, 1, 254]))
  const platform = new DatabaseSync(join(source, 'platform.db'))
  const mastra = new DatabaseSync(join(source, 'mastra.db'))
  const runtime = new WorkbenchRuntime(h.ctx, h.config, h.store, {
    boards: new WorkbenchBoards(h.config, { resolve: async () => undefined }), execute: vi.fn(),
  })
  try {
    platform.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE platform_investigation_runs (
        id TEXT, tapd_url TEXT, workflow_status TEXT, created_at TEXT, updated_at TEXT, report_content_hash TEXT
      );
      CREATE TABLE platform_profile_generations (id TEXT);
      CREATE TABLE platform_profile_evidence_snapshots (id TEXT);
      CREATE TABLE platform_git_repositories (id TEXT);
    `)
    const date = '2026-08-01T00:00:00.000Z'
    platform.prepare('INSERT INTO platform_investigation_runs VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-run', tapdUrl, 'success', date, date, createHash('sha256').update(report).digest('hex'))
    mastra.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE mastra_workflow_snapshot (workflow_name TEXT, run_id TEXT, snapshot BLOB, createdAt TEXT, updatedAt TEXT);
    `)
    const insert = mastra.prepare('INSERT INTO mastra_workflow_snapshot VALUES (?, ?, jsonb(?), ?, ?)')
    insert.run('incident-multi-agent-investigation-workflow', 'legacy-run', JSON.stringify({
      status: 'success', context: { input: { tapdUrl, additionalContext: '原补充背景' } },
      result: { title: '原调查', markdown: report.toString('utf8'), oldFormat: true },
    }), date, date)
    insert.run('incident-investigation-workflow', 'orphan-run', JSON.stringify({ status: 'pending' }), date, date)
    expect((await readFile(join(source, 'platform.db-wal'))).byteLength).toBeGreaterThan(0)
    const request = { sourceRoot: source, dataRoot: h.root, sourceCodeRoot: h.root,
      connectionId: 'test', maxResultBytes: h.config.maxResultBytes, store: h.store }
    const result = await importLegacy(request)
    expect(result).toMatchObject({ archivedRuns: 2, importedRuns: 1, structuredRuns: 0, reportOnlyRuns: 1,
      orphanRuns: ['orphan-run'], files: 2 })
    expect(await importLegacy(request)).toEqual(result)
    const runs = runtime.listRuns()
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run).toBeDefined()
    if (!run) throw new Error('Expected an imported investigation')
    expect(run).toMatchObject({ mode: 'dual', legacyRunId: 'legacy-run', additionalContext: '原补充背景' })
    expect(run.legacyLimitation).toContain('不计入新的画像证据')
    expect(await runtime.artifact(run.id, 'report')).toEqual(report)
    expect(await readFile(join(result.archive, 'evidence', 'legacy-run', 'attachment.bin')))
      .toEqual(Buffer.from([0, 255, 1, 254]))
    expect(await readFile(join(evidence, 'report.md'))).toEqual(report)
    expect(platform.prepare('SELECT COUNT(*) AS count FROM platform_investigation_runs').get()?.count).toBe(1)
    expect([...h.store.domain.table('imported').entries()]).toHaveLength(1)
  } finally {
    mastra.close()
    platform.close()
    await runtime.close()
    await h.close()
  }
})
