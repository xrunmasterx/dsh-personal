import { expect, it } from 'vitest'
import { codeGroups, codePatchHash } from '../src/code-groups.ts'
import { codeRecordSchema } from '../src/code-schema.ts'

function record(sha: string, message = '', diff = `+${sha}`) {
  return codeRecordSchema.parse({ id: `1_${sha}`, project: '1', sha, title: 'Same title', message,
    author: 'user', committedAt: '2026-09-18T00:00:00Z', discoveredAt: '2026-09-18T00:00:00Z', url: 'https://git.woa.com/x/y',
    branches: [], stage: 'development', stageEvents: [], sourceSha: null, patchHash: null, equivalentTo: null,
    diff, diffExpired: false, chunks: [], analysis: { summary: sha, matches: [] }, analyzedAt: null, error: null, attempts: 0 })
}
it('groups transitive cherry picks without discarding changed patches or merging equal titles', () => {
  const a = record('a'.repeat(40))
  const b = record('b'.repeat(40), `cherry picked from commit ${a.sha.slice(0, 8)}`)
  const c = record('c'.repeat(40), `cherry picked from commit ${b.sha}`)
  c.stage = 'validation'
  const unrelated = record('d'.repeat(40))
  const groups = codeGroups([a, b, c, unrelated])
  expect(groups).toHaveLength(2)
  expect(groups[0]?.commits.map(r => r.sha)).toEqual([a.sha, b.sha, c.sha])
  expect(groups[0]?.stage).toBe('validation')
  expect(groups[0]?.commits.map(r => r.analysis?.summary)).toEqual([a.sha, b.sha, c.sha])
  expect(codeGroups([c, unrelated, b, a]).map(g => g.commits.length).sort()).toEqual([1, 3])
})
it('ignores only patch offsets and object ids while preserving changed content', () => {
  const a = 'index 123..456\n@@ -1,2 +1,2 @@ test\n-old\n+new'
  const b = 'index 789..abc\n@@ -20,2 +30,2 @@ test\n-old\n+new'
  expect(codePatchHash(a)).toBe(codePatchHash(b))
  expect(codePatchHash(a)).not.toBe(codePatchHash(b.replace('+new', '+different')))
  expect(codeGroups([record('a'.repeat(40), '', a), record('b'.repeat(40), '', b)])).toHaveLength(1)
})
it('does not resolve ambiguous abbreviated sources or cross repository identities', () => {
  const a = record('abcdef12' + 'a'.repeat(32))
  const b = record('abcdef12' + 'b'.repeat(32))
  const c = record('c'.repeat(40), 'cherry picked from commit abcdef12')
  expect(codeGroups([a, b, c])).toHaveLength(3)
  b.project = '2'; b.message = `cherry picked from commit ${a.sha}`
  expect(codeGroups([a, b])).toHaveLength(2)
})
