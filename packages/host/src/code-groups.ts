/** Derived change groups retain every source commit without a second durable workflow. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { CodeRecord, CodePage } from './code-schema.ts'

/**
 * Fingerprint a patch without line offsets or blob object identities.
 * @param diff Complete source patch.
 * @returns Content fingerprint; whitespace and changed lines remain significant.
 */
export function codePatchHash(diff: string): string {
  return createHash('sha256').update(diff.replace(/^index .*\n/gm, '').replace(/^@@ .*? @@/gm, '@@')).digest('hex')
}

/**
 * Group verified identities and explicit cherry-pick chains before pagination.
 * @param records Retained source commits, including records outside the requested date window.
 * @returns Groups with original records available for audit and patch reads.
 */
export function codeGroups(records: CodeRecord[]): CodePage['items'] {
  const roots = new Map(records.map(r => [r.id, r.id]))
  const root = (id: CodeRecord['id']): CodeRecord['id'] => {
    const parent = roots.get(id)
    assert(parent)
    if (parent === id) return id
    const result = root(parent); roots.set(id, result); return result
  }
  const join = (a: CodeRecord, b: CodeRecord) => { roots.set(root(b.id), root(a.id)) }
  const patches = new Map<string, CodeRecord>()
  for (const record of records) {
    const hash = record.diff ? codePatchHash(record.diff) : record.patchHash
    const key = `${record.project}:${hash}`
    const same = hash ? patches.get(key) : undefined
    if (same) join(record, same)
    else if (hash) patches.set(key, record)
    const sources = [...record.message.matchAll(/cherry picked from commit ([a-f0-9]{7,64})/gi)].map((m) => { assert(m[1]); return m[1] })
    if (record.sourceSha) sources.push(record.sourceSha)
    for (const sha of sources) {
      const matches = records.filter(r => r.project === record.project && r.sha.startsWith(sha))
      if (matches.length === 1 && matches[0]) join(record, matches[0])
    }
    const equivalent = records.find(r => r.id === record.equivalentTo && r.project === record.project)
    if (equivalent) join(record, equivalent)
  }
  const groups = new Map<string, CodeRecord[]>()
  for (const record of records) {
    const key = root(record.id); const group = groups.get(key) ?? []
    group.push(record); groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    group.sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.id.localeCompare(b.id))
    const first = group[0]
    const latest = group.at(-1)
    assert(first && latest)
    const analyzed = group.filter(r => r.analysis)
    const latestAnalysis = analyzed.at(-1)?.analysis
    const matches = new Map<string, string[]>()
    for (const r of analyzed) for (const match of r.analysis?.matches ?? []) {
      const summaries = matches.get(match.taskId) ?? []
      if (!summaries.includes(match.summary)) summaries.push(match.summary)
      matches.set(match.taskId, summaries)
    }
    const strip = ({ diff: _diff, chunks: _chunks, ...record }: CodeRecord) => record
    const stage = group.some(r => r.stage === 'main') ? 'main' : group.some(r => r.stage === 'validation') ? 'validation' : 'development'
    return { ...strip(first), committedAt: latest.committedAt, stage,
      branches: [...new Set(group.flatMap(r => r.branches))],
      stageEvents: group.flatMap(r => r.stageEvents).sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
      analysis: latestAnalysis ? { summary: latestAnalysis.summary,
        matches: [...matches].map(([taskId, summaries]) => ({ taskId, summary: summaries.join('\n\n') })) } : null,
      error: group.find(r => r.error)?.error ?? null, commits: group.map(strip),
    }
  })
}
