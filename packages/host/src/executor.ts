/** Codex calls owned by DSH's process-tree supervisor, with durable input snapshots. */
import type { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { modelFailure, redactDiagnostic } from './diagnostics.ts'
import type { Config } from './config.ts'
import type { RunRecord } from './models.ts'
import { toCodexOutputSchema } from './incident/codex.ts'
import { RunBudget, removeOwnedPath, storageFiles } from './storage.ts'

/** One isolated model call; the executor never resumes a previous Case thread. */
export interface ModelRequest {
  prompt: string
  schema: z.ZodType
  directory: string
  name: string
  profile: boolean
  signal: AbortSignal
  budget?: RunBudget
  activity?: (message: NonNullable<RunRecord['activity']>['message']) => Promise<void>
}

/** Codex CLI adaptation used by both deterministic workflows. */
export type ModelExecutor = (request: ModelRequest) => Promise<unknown>

const resultSchema = z.object({
  threadId: z.string().nullable(),
  response: z.string(),
  usage: z.unknown(),
  items: z.array(z.unknown()),
  error: z.string().nullable(),
})

/**
 * Bind model execution to this Host's subprocess provider and configuration.
 * @param ctx - Host carrying the process-tree service.
 * @param config - validated deployment policy.
 * @returns executor that settles only after the entire worker tree exits.
 */
export function createModelExecutor(ctx: Context, config: Config): ModelExecutor {
  return async (request) => {
    request.signal.throwIfAborted()
    const worker = createRequire(import.meta.url).resolve(
      '@xrunmasterx/dsh-personal-host/worker',
    )
    const input = {
      prompt: request.prompt,
      outputSchema: toCodexOutputSchema(request.schema),
      cwd: request.profile ? request.directory : config.sourceRoot,
      evidenceDirectory: request.profile ? request.directory : dirname(request.directory),
      provider: config.modelProvider,
      model: request.profile ? config.profileModel : config.investigationModel,
      reasoning: config.reasoningEffort,
      network: config.investigationNetworkAccess,
      profile: request.profile,
      schemaPath: join(request.directory, `${request.name}.schema.json`),
      cacheDirectory: join(request.directory, `${request.name}.codex-cache`),
      eventsPath: join(request.directory, `${request.name}.events.jsonl`),
      maxResultBytes: config.maxResultBytes,
    }
    await mkdir(request.directory, { recursive: true })
    const budget =
      request.budget ??
      new RunBudget(
        config.storage.maxRunBytes,
        (await storageFiles(request.directory)).reduce((sum, file) => sum + file.size, 0),
      )
    const snapshot = `${JSON.stringify(input, null, 2)}\n`
    const schema = JSON.stringify(input.outputSchema)
    // Reserve the bounded failure record before the model can exhaust the file allowance.
    budget.charge(Buffer.byteLength(snapshot) + Buffer.byteLength(schema) + config.maxResultBytes + 65_536)
    await writeFile(join(request.directory, `${request.name}.input.json`), snapshot, {
      flag: 'wx',
    })
    await writeFile(input.schemaPath, schema, { flag: 'wx' })
    await mkdir(input.cacheDirectory, { recursive: true })
    request.signal.throwIfAborted()
    const processHandle = ctx.subprocess.spawn({
      argv: [process.execPath, worker],
      cwd: request.directory,
      stdio: {
        stdin: { data: JSON.stringify(input) },
        stdout: { maxBytes: config.maxResultBytes },
        stderr: { maxBytes: config.maxResultBytes },
      },
      graceMs: config.processGraceMs,
      signal: request.signal,
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    let activityWrite: Promise<void> = Promise.resolve()
    let stopped = false
    let offset = 0
    let pending = ''
    let activityError: unknown
    let cachePeak = 0
    const measureCache = async () => {
      const bytes = (await storageFiles(input.cacheDirectory)).reduce((total, file) => total + file.size, 0)
      if (bytes > cachePeak) {
        budget.charge(bytes - cachePeak)
        cachePeak = bytes
      }
    }
    const poll = () => {
      timer = setTimeout(() => {
        activityWrite = (async () => {
          await measureCache()
          const output = processHandle.collected.stderr?.readFrom(offset)
          if (!output) return
          offset = output.nextOffset
          pending += output.text
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          const last = lines.at(-1)
          const parsed = last
            ? z
              .object({ activity: z.enum(['reading_source', 'model_running', 'validating_result']) })
              .parse(JSON.parse(last) as unknown)
            : null
          await request.activity?.(parsed?.activity ?? 'model_running')
        })()
          .catch((error: unknown) => {
            activityError = error
            processHandle.terminate()
          })
          .finally(() => {
            if (!stopped) poll()
          })
      }, config.pollIntervalMs)
    }
    poll()
    let diagnosticWritten = false
    try {
      const outcome = await processHandle.done
      await measureCache()
      assert(processHandle.collected.stdout, 'Model execution requests collected stdout')
      const output = processHandle.collected.stdout.readFrom(0)
      const diagnosticLimit = Math.floor((config.maxResultBytes - 128) / 6)
      const diagnostic = JSON.stringify({
        raw: redactDiagnostic(output.text, diagnosticLimit),
        truncated: output.text.length > diagnosticLimit,
      })
      budget.charge(Buffer.byteLength(diagnostic))
      await writeFile(join(request.directory, `${request.name}.trace.json`), diagnostic, { flag: 'wx' })
      diagnosticWritten = true
      request.signal.throwIfAborted()
      if (activityError) throw new Error('Model activity or cache accounting failed', { cause: activityError })
      if (output.lossy) throw new Error('Codex output exceeded the configured result limit')
      const result = resultSchema.parse(JSON.parse(output.text) as unknown)
      if (outcome.exitCode !== 0 || result.error)
        throw new Error(result.error ?? `Codex exited with code ${outcome.exitCode}`)
      const value = request.schema.parse(JSON.parse(result.response) as unknown)
      const saved = `${JSON.stringify({ ...result, response: value }, null, 2)}\n`
      budget.charge(Buffer.byteLength(saved))
      await writeFile(join(request.directory, `${request.name}.output.json`), saved, { flag: 'wx' })
      return value
    } catch (error) {
      const detail = redactDiagnostic(error instanceof Error ? error.message : 'Model execution failed', 12000)
      try {
        await writeFile(
          join(request.directory, `${request.name}.error.json`),
          JSON.stringify({ error: detail, at: new Date().toISOString(), diagnosticWritten }),
          { flag: 'wx' },
        )
      } catch (writeError) {
        ctx.logger.warn(
          'Could not retain model error: %s',
          redactDiagnostic(writeError instanceof Error ? writeError.message : 'Write failed', 500),
        )
      }
      if (request.signal.aborted) throw error
      throw new Error(modelFailure(detail), { cause: error })
    } finally {
      stopped = true
      clearTimeout(timer)
      await activityWrite
      processHandle.terminate()
      try {
        await processHandle.waitForExit()
        // The main execution path already observes spawn failures.
        await Promise.allSettled([processHandle.done])
      } finally {
        await removeOwnedPath(request.directory, input.cacheDirectory)
      }
    }
  }
}
