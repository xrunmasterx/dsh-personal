/** Stable fact identities separate a repeated collection from a changed work fact. */
import { createHash } from 'node:crypto'
import type { PersonalProfileEvidence } from './schema.ts'

/**
 * Identify one work fact across old imports, new runs and publications.
 * @param item - evidence from a frozen snapshot or publication.
 * @returns identity independent of collection time and execution ID.
 */
export function factKey(item: PersonalProfileEvidence): string {
  if (item.kind !== 'investigation') return item.id
  if (item.url) {
    const url = new URL(item.url)
    const report = /\/crashes\/([^/]+)\/[^/]+\/report-id\/([^/]+)/.exec(url.pathname)
    if (report) return `${item.source}:investigation:${report[1]}:${url.searchParams.get('pid')}:${report[2]}`
  }
  return `${item.source}:investigation:${item.entityId}`
}

/**
 * Hash substantive evidence, excluding collection and execution metadata.
 * @param item - one retained work fact.
 * @returns version used to distinguish new support from a repeated run.
 */
export function factVersion(item: PersonalProfileEvidence): string {
  const summary = item.summary
    .replace(/来源运行：[\s\S]*?；/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return createHash('sha256')
    .update(JSON.stringify([factKey(item), item.title, summary, [...item.tags].sort()]))
    .digest('hex')
}

/**
 * Compare facts within the same UTC date window without treating an intraday recheck as new evidence.
 * @param snapshot - source facts and availability observed by a collection.
 * @returns semantic digest including window dates but excluding collection timestamps and snapshot IDs.
 */
export function evidenceDigest(snapshot: {
  evidence: PersonalProfileEvidence[]
  coverage: { source: string; status: string; itemCount: number; limitation: string | null }[]
  window?: { recentStart: string; focusStart: string; end: string }
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        windowDays: snapshot.window
          ? [snapshot.window.recentStart, snapshot.window.focusStart, snapshot.window.end].map(date => date.slice(0, 10))
          : null,
        facts: snapshot.evidence.map(item => [factKey(item), factVersion(item)]).sort(),
        coverage: snapshot.coverage.map(({ source, status, itemCount, limitation }) => ({
          source,
          status,
          itemCount,
          limitation,
        })),
      }),
    )
    .digest('hex')
}
