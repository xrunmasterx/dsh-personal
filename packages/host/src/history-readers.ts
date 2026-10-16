/** Read committed local Codex and Cursor records without mutating their databases. */
import { DatabaseSync } from 'node:sqlite'
import { open, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HistoryId, HistoryMessage, HistoryMessageId, HistorySourceSession } from './history-schema.ts'
import { redactHistory } from './history-redaction.ts'

/** Complete text and source-read bounds selected by deployment. */
export interface HistoryReadPolicy {
  /** Minimum source inactivity before ingesting a completed response. */
  stableMs: number
  /** Maximum characters per analysis chunk; retained messages are not clipped. */
  maxMessageChars: number
  /** Maximum buffered bytes while finding a complete source record. */
  maxSessionBytes: number
}

/**
 * Stable content identity; changing metadata never changes a message version.
 * @param value - source identity or filtered message content.
 * @returns SHA-256 digest.
 */
export function historyHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/**
 * Namespace an external session by source and local store.
 * @param session - verified local source identity.
 * @returns persistent Personal identity.
 */
export function historyId(session: Pick<HistorySourceSession, 'source' | 'sourceId' | 'location'>): HistoryId {
  return brandString<HistoryId>(historyHash([session.source, session.location, session.sourceId]))
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function str(value: unknown): string { return typeof value === 'string' ? value : '' }
function parse(value: unknown): Record<string, unknown> {
  return object(JSON.parse(value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : str(value)))
}
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => str(object(part).text)).filter(Boolean).join('\n')
  return ''
}
function title(value: unknown, fallback: string): string {
  return redactHistory(str(value)).replace(/<(agents-instructions|environment_context)\b[^>]*>[\s\S]*?<\/\1>/g, '').trim().slice(0, 200) || fallback
}
function message(id: string, at: unknown, role: HistoryMessage['role'], body: string): HistoryMessage | null {
  if (!body.trim() || !str(at) || !Number.isFinite(Date.parse(str(at)))) return null
  if (role === 'user') {
    body = body.replace(/<(environment_context|agents-instructions|system_reminder|recommended_plugins|in-app-browser-context)\b[^>]*>[\s\S]*?<\/\1>/g, '').trim()
    if (/^\s*# AGENTS\.md instructions/.test(body)) return null
    if (!body) return null
  }
  // Credentials in visible messages must not become model input or retained transcript text.
  const filtered = redactHistory(body)
  return { id: brandString<HistoryMessageId>(id), at: new Date(str(at)).toISOString(), role, text: filtered,
    hash: historyHash([role, filtered]), truncated: false }
}

/** Reader caches only source positions; durable message fingerprints remain the deduplication authority. */
export class HistoryReaders {
  private codexCache = new Map<string, {
    path: string
    size: number
    mtime: number
    prefix: string
    userTurn: boolean
    messages: HistoryMessage[]
  }>()

  /**
   * Check existence separately from eligibility, so old or busy sessions are not treated as deleted.
   * @param source - source adapter.
   * @param root - successfully opened store directory.
   * @param sourceId - original session identity.
   * @returns false only for a missing row or missing Codex rollout.
   */
  async available(source: 'codex' | 'cursor', root: string, sourceId: string): Promise<boolean> {
    const db = new DatabaseSync(join(root, source === 'codex' ? 'state_5.sqlite' : 'state.vscdb'), { readOnly: true })
    try {
      const row = source === 'codex'
        ? db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(sourceId)
        : db.prepare('SELECT composerId FROM composerHeaders WHERE composerId = ?').get(sourceId)
      if (!row) return false
      if (source === 'codex') {
        try { await stat(str(row.rollout_path)) } catch (error) { if (object(error).code === 'ENOENT') return false; throw error }
      }
      return true
    } finally { db.close() }
  }

  /**
   * Read all eligible root Codex sessions, including archived and continued old sessions.
   * @param root - configured Codex home.
   * @param since - discovery activity cutoff; selected sessions retain all messages.
   * @param policy - stability and byte limits.
   * @param signal - owner cancellation.
   * @param tracked - previously archived session IDs, independent of discovery cutoff.
   * @returns root sessions with stable filtered messages.
   */
  async codex(root: string, since: number, policy: HistoryReadPolicy,
    signal: AbortSignal, tracked: ReadonlySet<string> = new Set()): Promise<HistorySourceSession[]> {
    const db = new DatabaseSync(join(root, 'state_5.sqlite'), { readOnly: true })
    const output: HistorySourceSession[] = []
    try {
      const rows = db.prepare("SELECT id, name, title, cwd, rollout_path, updated_at FROM threads WHERE source NOT LIKE '%subagent%'").all()
      for (const row of rows) {
        signal.throwIfAborted()
        const path = str(row.rollout_path)
        let info
        try { info = await stat(path) } catch (error) {
          if (object(error).code === 'ENOENT') continue
          throw error
        }
        if (!tracked.has(str(row.id)) && Math.max(Number(row.updated_at) * 1000, info.mtimeMs) < since) continue
        if (policy.stableMs > 0 && Date.now() - info.mtimeMs < policy.stableMs) continue
        const key = str(row.id)
        const previous = this.codexCache.get(key)
        const cached = previous
        if (cached?.size === info.size && cached.mtime === info.mtimeMs && cached.path === path) {
          output.push({ source: 'codex', sourceId: key, location: root, title: title(row.name || row.title, key), cwd: str(row.cwd), messages: cached.messages })
          continue
        }
        const file = await open(path, 'r')
        try {
          const head = Buffer.alloc(Math.min(256, info.size))
          await file.read(head, 0, head.length, 0)
          const prefix = historyHash(head.toString('utf8'))
          const append = cached && cached.path === path && cached.size < info.size && cached.prefix === prefix
          const start = append ? cached.size : 0
          const messages = append ? [...cached.messages] : []
          let userTurn = append ? cached.userTurn : true
          let position = start
          let remainder = ''
          // Stream bounded chunks: a long-running session must not require a full-file allocation.
          const stream = file.createReadStream({ start, autoClose: false, encoding: 'utf8', signal })
          for await (const chunk of stream) {
            remainder += String(chunk)
            if (Buffer.byteLength(remainder) > policy.maxSessionBytes) throw new Error(`Codex record exceeds read limit: ${key}`)
            let newline: number
            while ((newline = remainder.indexOf('\n')) >= 0) {
              const line = remainder.slice(0, newline)
              remainder = remainder.slice(newline + 1)
              const offset = position
              position += Buffer.byteLength(line + '\n')
              if (!line.trim()) continue
              const record = parse(line)
              const payload = object(record.payload)
              if (record.type === 'event_msg' && payload.type === 'task_started') userTurn = false
              const at = str(record.timestamp)
              if (!at) continue
              let entry: HistoryMessage | null = null
              if (record.type === 'response_item' && payload.type === 'message' && payload.channel !== 'analysis' && (payload.role === 'user' || (payload.role === 'assistant' && userTurn)))
                entry = message(String(offset), at, payload.role, text(payload.content))
              if (entry?.role === 'user') userTurn = true
              if (entry?.role === 'assistant' && (payload.channel === 'commentary' || payload.channel === 'final'))
                entry.phase = payload.channel === 'commentary' ? 'progress' : 'answer'
              if (entry) messages.push(entry)
            }
          }
          this.codexCache.set(key, { path, size: position, mtime: info.mtimeMs, prefix, userTurn, messages })
          output.push({ source: 'codex', sourceId: key, location: root, title: title(row.name || row.title, key), cwd: str(row.cwd), messages })
        } catch (error) {
          signal.throwIfAborted()
          output.push({ source: 'codex', sourceId: key, location: root, title: title(row.name || row.title, key),
            cwd: str(row.cwd), messages: [], sourceError: error instanceof Error ? error.message : String(error) })
        } finally { await file.close() }
      }
      return output
    } finally { db.close() }
  }

  /**
   * Read Cursor messages independently of the frequently stale lastUpdatedAt header.
   * @param root - Cursor User/globalStorage directory.
   * @param since - discovery activity cutoff; selected sessions retain all messages.
   * @param policy - stability and text limits.
   * @param signal - owner cancellation.
   * @param tracked - previously archived session IDs, independent of discovery cutoff.
   * @returns filtered stable IDE conversations.
   */
  async cursor(root: string, since: number, policy: HistoryReadPolicy,
    signal: AbortSignal, tracked: ReadonlySet<string> = new Set()): Promise<HistorySourceSession[]> {
    const db = new DatabaseSync(join(root, 'state.vscdb'), { readOnly: true })
    try {
      db.exec('BEGIN')
      const rows = db.prepare('SELECT composerId, value FROM composerHeaders WHERE isSubagent = 0').all()
      const data = db.prepare("SELECT json_extract(value, '$.fullConversationHeadersOnly') AS headers, json_extract(value, '$.generatingBubbleIds') AS generating FROM cursorDiskKV WHERE key = ?")
      const bubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      const output: HistorySourceSession[] = []
      for (const row of rows) {
        signal.throwIfAborted()
        const sourceId = str(row.composerId)
        try {
          const header = parse(row.value)
          if (header.isDraft) continue
          const composer = data.get(`composerData:${sourceId}`)
          if (composer?.generating) {
            const generating: unknown = JSON.parse(str(composer.generating))
            if (!Array.isArray(generating)) throw new Error('Unsupported Cursor generation state')
            if (generating.length > 0) continue
          }
          const raw = composer?.headers
          if (!raw) continue
          const headers: unknown = JSON.parse(str(raw))
          if (!Array.isArray(headers)) throw new Error(`Cursor conversation headers are unsupported: ${sourceId}`)
          const eligible = headers.map(object)
          if (!tracked.has(sourceId) && !eligible.some(h => Date.parse(str(h.createdAt)) >= since)) continue
          const latest = Math.max(...eligible.map(h => Date.parse(str(h.createdAt))),
            Number(header.conversationCheckpointLastUpdatedAt) || 0)
          if (Date.now() - latest < policy.stableMs || header.isGenerating) continue
          const messages: HistoryMessage[] = []
          const phases = new Map<string, HistoryMessage['phase']>()
          let answered = false
          for (const h of [...eligible].reverse()) {
            if (h.type === 1) { answered = false; continue }
            if (h.type !== 2) continue
            const duration = object(h.grouping).turnDurationMs
            if (typeof duration === 'number' && Number.isFinite(duration)) {
              phases.set(str(h.bubbleId), 'answer'); answered = true
            } else if (answered) phases.set(str(h.bubbleId), 'progress')
          }
          for (const h of eligible) {
            const id = str(h.bubbleId)
            const rawBubble = bubble.get(`bubbleId:${sourceId}:${id}`)?.value
            if (!rawBubble) throw new Error(`Cursor message is unavailable: ${sourceId}/${id}`)
            const b = parse(rawBubble)
            if (h.type !== 1 && h.type !== 2) continue
            const entry = message(id, h.createdAt, h.type === 1 ? 'user' : 'assistant', str(b.text))
            if (entry && phases.has(id)) entry.phase = phases.get(id)
            if (entry) messages.push(entry)
          }
          output.push({ source: 'cursor', sourceId, location: root, title: str(header.name) || sourceId,
            cwd: str(object(object(header.workspaceIdentifier).uri).fsPath), messages })
        } catch (error) {
          signal.throwIfAborted()
          output.push({ source: 'cursor', sourceId, location: root, title: sourceId, cwd: '', messages: [],
            sourceError: error instanceof Error ? error.message : String(error) })
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return output
    } finally { db.close() }
  }
}
