/** Bounded read-only Git commands supervised by the Host process service. */
import type { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import type { Config } from '../config.ts'

/**
 * Read Git facts without changing refs, the index or the working tree.
 * @param ctx - Host subprocess owner.
 * @param config - output, timeout and process cleanup policy.
 * @param cwd - explicit repository directory.
 * @param args - feature-owned read command arguments.
 * @param signal - owning operation lifetime.
 * @returns exit status and bounded output for source-specific interpretation.
 */
export async function readGitCommand(
  ctx: Context,
  config: Config,
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const commandSignal = AbortSignal.any([signal, AbortSignal.timeout(config.toolTimeoutMs)])
  const git = await ctx.subprocess.resolveExecutable('git', undefined, commandSignal)
  const handle = ctx.subprocess.spawn({
    argv: [git, '-C', cwd, ...args],
    cwd,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxResultBytes },
      stderr: { maxBytes: config.maxResultBytes },
    },
    graceMs: config.processGraceMs,
    signal: commandSignal,
  })
  try {
    const outcome = await handle.done
    commandSignal.throwIfAborted()
    assert(handle.collected.stdout && handle.collected.stderr, 'Git reads collect both output streams')
    const stdout = handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr.readFrom(0)
    if (stdout.lossy || stderr.lossy) throw new Error('Git evidence exceeds the configured byte limit')
    return { exitCode: outcome.exitCode ?? 1, stdout: stdout.text, stderr: stderr.text }
  } finally {
    handle.terminate()
    await handle.waitForExit()
    await handle.done
  }
}
