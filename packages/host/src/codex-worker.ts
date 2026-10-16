/** Internal Codex CLI adapter: ephemeral sessions, bounded events and isolated operational state. */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { redactDiagnostic } from './diagnostics.ts'
import { prepareCodexHome } from './codex-home.ts'

const requestSchema = z
  .object({
    prompt: z.string().min(1),
    outputSchema: z.record(z.string(), z.unknown()),
    schemaPath: z.string(),
    cacheDirectory: z.string(),
    eventsPath: z.string(),
    maxResultBytes: z.number().int().positive(),
    cwd: z.string().min(1),
    evidenceDirectory: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoning: z.enum(['low', 'medium', 'high', 'xhigh']),
    network: z.boolean(),
    profile: z.boolean(),
  })
  .strict()
const eventSchema = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    item: z.object({ type: z.string(), id: z.string().optional(), text: z.string().optional() }).loose().optional(),
    usage: z.unknown().optional(),
    error: z.object({ message: z.string() }).optional(),
    message: z.string().optional(),
  })
  .loose()

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  const input = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
  writeFileSync(input.eventsPath, '', { flag: 'wx', mode: 0o600 })
  await prepareCodexHome(process.env.CODEX_HOME ?? join(homedir(), '.codex'), input.cacheDirectory, input.provider)
  const cli = join(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), 'bin', 'codex.js')
  const settings: Record<string, boolean | string> = {
    model_provider: input.provider,
    model_reasoning_effort: input.reasoning,
    approval_policy: 'never',
    web_search: 'disabled',
    'history.persistence': 'none',
    log_dir: input.cacheDirectory,
    sqlite_home: input.cacheDirectory,
    'apps._default.enabled': false,
    'tools.web_search': false,
    'tools.view_image': false,
    'sandbox_workspace_write.network_access': input.profile ? false : input.network,
    'features.shell_tool': !input.profile,
    'features.unified_exec': !input.profile,
  }
  for (const feature of [
    'apps',
    'plugins',
    'hooks',
    'multi_agent',
    'browser_use',
    'browser_use_external',
    'computer_use',
    'in_app_browser',
    'image_generation',
    'skill_search',
    'tool_suggest',
    'shell_snapshot',
    'secret_auth_storage',
    'workspace_dependencies',
    'memories',
  ])
    settings[`features.${feature}`] = false
  const args = [
    cli,
    'exec',
    '--ephemeral',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--cd',
    input.cwd,
    '--model',
    input.model,
    '--output-schema',
    input.schemaPath,
    '--config',
    'mcp_servers={}',
    ...Object.entries(settings).flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`]),
    ...(!input.profile ? ['--add-dir', input.evidenceDirectory] : []),
    '-',
  ]
  const child = spawn(process.execPath, args, {
    env: { ...scrubbedParentEnv(), CODEX_HOME: input.cacheDirectory, CODEX_SQLITE_HOME: input.cacheDirectory },
    windowsHide: true,
    stdio: 'pipe',
  })
  let stderr = ''
  const errors: { spawn: Error | null; failure: string | null } = { spawn: null, failure: null }
  let retainedBytes = 0
  const retain = (event: unknown): boolean => {
    const record = `${redactDiagnostic(JSON.stringify({ at: new Date().toISOString(), event }), input.maxResultBytes)}\n`
    const size = Buffer.byteLength(record)
    try {
      if (retainedBytes + size > input.maxResultBytes)
        throw new Error('Codex diagnostics exceeded the configured result limit')
      appendFileSync(input.eventsPath, record)
      retainedBytes += size
      return true
    } catch (error) {
      errors.failure = error instanceof Error ? error.message : 'Could not retain Codex diagnostics'
      child.kill()
      return false
    }
  }
  child.on('error', (error) => {
    errors.spawn = error
  })
  child.stdin.on('error', (error) => {
    errors.spawn = error
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const message = redactDiagnostic(chunk.toString('utf8'), 12000)
    stderr = (stderr + message).slice(-12000)
    retain({ type: 'process.stderr', message })
  })
  const closed = new Promise<number | null>(resolveCode => child.once('close', resolveCode))
  child.stdin.end(input.prompt)
  let threadId: string | null = null
  let response = ''
  let usage: unknown = null
  let bytes = 0
  const items: unknown[] = []
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      bytes += Buffer.byteLength(line)
      if (bytes > input.maxResultBytes) throw new Error('Codex events exceeded the configured result limit')
      const event = eventSchema.parse(JSON.parse(line) as unknown)
      if (event.item?.type !== 'reasoning' && !retain(event)) break
      if (event.type === 'thread.started') threadId = event.thread_id ?? null
      if (event.type === 'turn.completed') usage = event.usage
      if (event.type === 'turn.failed')
        errors.failure = event.error?.message ?? event.message ?? 'Codex turn failed'
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message') response = event.item.text ?? ''
        if (event.item.type !== 'reasoning') items.push(event.item)
      }
      const activity =
        event.item?.type === 'command_execution'
          ? 'reading_source'
          : event.type === 'turn.completed'
            ? 'validating_result'
            : 'model_running'
      process.stderr.write(`${JSON.stringify({ activity, at: new Date().toISOString() })}\n`)
    }
  } catch (error) {
    errors.failure = error instanceof Error ? error.message : 'Codex event stream failed'
    child.kill()
  }
  const exitCode = await closed
  const error =
    errors.failure ??
    (errors.spawn ? String(errors.spawn) : exitCode !== 0 ? stderr || `Codex exited with code ${exitCode}` : null)
  process.stdout.write(
    JSON.stringify({ threadId, response, usage, items, error: error ? redactDiagnostic(error, 12000) : null }),
  )
  if (error) process.exitCode = 1
}

void main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({
      threadId: null,
      response: '',
      usage: null,
      items: [],
      error: redactDiagnostic(error instanceof Error ? error.message : 'Codex worker failed', 12000),
    }),
  )
  process.exitCode = 1
})
