import * as childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--fixture-stream')) {
  const events = [
    { type: 'thread.started', thread_id: 'fixture-thread' },
    { type: 'turn.started' },
    { type: 'error', message: 'Reconnecting... 1/5: wss://example.test/responses?signature=private' },
    ...(process.argv.at(-1) === 'failed'
      ? [{ type: 'turn.failed', error: { message: 'service unavailable' } }]
      : [
          { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: '{"ok":true}' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]),
  ]
  process.stdin.resume()
  for (const event of events) process.stdout.write(JSON.stringify(event) + '\n')
  if (process.argv.at(-1) === 'failed') process.exitCode = 1
} else {
  const original = childProcess.default.spawn
  childProcess.default.spawn = (command, args, options) => {
    if (!String(args[0]).replaceAll('\\', '/').endsWith('/bin/codex.js')) {
      throw new Error('Unexpected subprocess in Codex stream fixture')
    }
    return original(command, [fileURLToPath(import.meta.url), '--fixture-stream', process.env.DSH_WORKER_FIXTURE_OUTCOME], options)
  }
  syncBuiltinESMExports()
}
