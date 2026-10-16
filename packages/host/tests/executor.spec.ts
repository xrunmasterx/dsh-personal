import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createModelExecutor } from '../src/executor.ts'
import { harness } from './helpers.ts'

async function gone(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
  if (process.platform !== 'linux') return false
  try {
    const state = await readFile(`/proc/${pid}/stat`, 'utf8')
    return ['Z', 'X'].includes(state.slice(state.lastIndexOf(')') + 2, state.lastIndexOf(')') + 3))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

it('joins a real worker and its signal-resistant descendant before model cancellation settles', async () => {
  const h = await harness()
  const ready = join(h.root, 'worker-ready.json')
  const originalSpawn = h.ctx.subprocess.spawn.bind(h.ctx.subprocess)
  const fixture = fileURLToPath(new URL('./fixtures/model-worker.mjs', import.meta.url))
  const spy = vi.spyOn(h.ctx.subprocess, 'spawn').mockImplementation(spec =>
    originalSpawn({
      ...spec,
      argv: [process.execPath, fixture, ready],
    }),
  )
  const controller = new AbortController()
  const execute = createModelExecutor(h.ctx, h.config)
  const finished = execute({
    prompt: 'fixture',
    schema: z.object({ result: z.string() }),
    directory: join(h.root, 'model'),
    name: 'cancel',
    profile: true,
    signal: controller.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  )
  try {
    let ids: { worker: number; child: number } | undefined
    await vi.waitFor(
      async () => {
        ids = z
          .object({ worker: z.number().int(), child: z.number().int() })
          .parse(JSON.parse(await readFile(ready, 'utf8')) as unknown)
      },
      { timeout: 20_000 },
    )
    if (!ids) throw new Error('Worker never became ready')
    expect(await gone(ids.worker)).toBe(false)
    expect(await gone(ids.child)).toBe(false)
    controller.abort(new DOMException('Canceled by the user', 'AbortError'))
    expect(await finished).toMatchObject({ name: 'AbortError' })
    expect(await gone(ids.worker)).toBe(true)
    expect(await gone(ids.child)).toBe(true)
    expect(await readFile(join(h.root, 'model', 'cancel.events.jsonl'), 'utf8')).toContain('cancel-probe')
    expect(await readdir(join(h.root, 'model'))).not.toContain('cancel.codex-cache')
    expect(await readFile(join(h.root, 'model', 'cancel.error.json'), 'utf8')).toContain('Canceled by the user')
  } finally {
    controller.abort()
    await finished
    spy.mockRestore()
    await h.close()
  }
}, 30_000)
