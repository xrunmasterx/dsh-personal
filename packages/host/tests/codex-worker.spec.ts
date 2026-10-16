import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'

it.each(['completed', 'failed'])('retains retries and follows the terminal %s outcome', async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-stream-'))
  const source = join(root, 'login')
  const cache = join(root, 'cache')
  await mkdir(source)
  await mkdir(cache)
  const eventsPath = join(root, 'events.jsonl')
  try {
    const result = await new Promise<{ output: string; code: number }>((resolve, reject) => {
      const child = execFile(process.execPath, [
        '--import', new URL('./fixtures/codex-stream.mjs', import.meta.url).href,
        '--import', 'tsx/esm',
        fileURLToPath(new URL('../src/codex-worker.ts', import.meta.url)),
      ], {
        env: { ...process.env, CODEX_HOME: source, DSH_WORKER_FIXTURE_OUTCOME: outcome },
        timeout: 20_000,
        windowsHide: true,
      }, (error, stdout) => {
        if (!error) resolve({ output: stdout, code: 0 })
        else if (typeof error.code === 'number') resolve({ output: stdout, code: error.code })
        else reject(new Error('Codex fixture process did not exit normally', { cause: error }))
      })
      child.stdin!.end(JSON.stringify({ prompt: 'fixture', outputSchema: {}, schemaPath: join(root, 'schema.json'),
        cacheDirectory: cache, eventsPath, maxResultBytes: 65536, cwd: root, evidenceDirectory: root,
        provider: 'openai', model: 'fixture', reasoning: 'low', network: false, profile: false }))
    })
    const response = z.object({ response: z.string(), error: z.string().nullable() })
      .parse(JSON.parse(result.output) as unknown)
    expect(result.code).toBe(outcome === 'completed' ? 0 : 1)
    expect(response.error).toBe(outcome === 'completed' ? null : 'service unavailable')
    if (outcome === 'completed') expect(JSON.parse(response.response)).toEqual({ ok: true })
    const events = await readFile(eventsPath, 'utf8')
    expect(events).toContain('Reconnecting')
    expect(events).toContain('[remote URL]')
    expect(events).not.toContain('signature=private')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
