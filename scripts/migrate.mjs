/** Copy a stopped legacy Personal home; source records are never modified. */
import { mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { sessionFrames, compressSessionFrame } from './session-frames.mjs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } })
if (!values.from || !values.to) throw new Error('Use --from <stopped legacy home> --to <new empty home>')
const source = resolve(values.from), target = resolve(values.to)
if (target === source || target.startsWith(source + '/') || target.startsWith(source + '\\')) throw new Error('Migration requires an independent target')
try { await access(target); throw new Error('Migration target already exists; choose a new empty path') }
catch (error) { if (error.code !== 'ENOENT') throw error }
const audits = new Set(['personal-workbench/brief-polish-request', 'personal-workbench/brief-polish-result',
  'personal-workbench/history-request', 'personal-workbench/history-result', 'personal-workbench/history-invalid-result',
  'personal-workbench/code-request', 'personal-workbench/code-result', 'personal-workbench/code-invalid-result',
  'personal-workbench/review-request', 'personal-workbench/review-result', 'personal-workbench/review-invalid'])
const scopes = new Set(['personal-workbench/task-context', 'personal-workbench/board-context'])
await mkdir(dirname(target), { recursive: true })
await mkdir(target)
const manifest = { source, createdAt: new Date().toISOString(), files: [], optionalMetadataEvents: 0 }
async function copy(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    if (entry.isSymbolicLink()) throw new Error(`Unexpected data symlink: ${relative}/${entry.name}`)
    const name = join(relative, entry.name), from = join(source, name), to = join(target, name)
    if (entry.isDirectory()) { await mkdir(to, { recursive: true }); await copy(from, name); continue }
    const bytes = await readFile(from)
    let output = bytes
    if (name.startsWith('sessions') && /\.jsonl(?:\.zstd)?$/.test(entry.name)) {
      const compressed = entry.name.endsWith('.zstd')
      const decoded = sessionFrames(bytes, compressed)
      const frames = []
      for (const frame of decoded) {
        const original = bytes.subarray(frame.start, frame.end)
        const plain = frame.plain
        let changed = false
        const rewritten = Buffer.from(plain.toString('utf8').split('\n').map(line => {
          if (!line.trim()) return line
          const record = JSON.parse(line)
          if (audits.has(record.type) || scopes.has(record.type)) {
            if (record.surfaceOp !== undefined || record.sourceEventSeqs !== undefined) throw new Error(`Personal metadata unexpectedly alters model history: ${record.type}`)
            if (record.ignorable === true) return line
            record.ignorable = true
            changed = true
            manifest.optionalMetadataEvents++
            return JSON.stringify(record)
          }
          if (typeof record.type === 'string' && record.type.startsWith('personal-workbench/')) throw new Error(`Unreviewed Personal event: ${record.type}`)
          return line
        }).join('\n'))
        frames.push(changed ? compressed ? compressSessionFrame(rewritten) : rewritten : original)
      }
      output = Buffer.concat(frames)
    }
    await writeFile(to, output)
    const hash = data => createHash('sha256').update(data).digest('hex')
    if (hash(await readFile(to)) !== hash(output)) throw new Error(`Copied data mismatch: ${name}`)
    manifest.files.push({ name, originalSha256: hash(bytes), copiedSha256: hash(output), bytes: bytes.length })
  }
}
await copy(source)
await writeFile(join(target, 'personal-migration.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`Copied and verified ${manifest.files.length} files; ${manifest.optionalMetadataEvents} metadata events classified. Original home unchanged.`)
