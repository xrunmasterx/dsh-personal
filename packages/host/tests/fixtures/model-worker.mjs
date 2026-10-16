import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'

const [readyPath] = process.argv.slice(2)
if (!readyPath) throw new Error('A readiness path is required')
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
await writeFile(input.eventsPath, `${JSON.stringify({ event: { type: 'thread.started', thread_id: 'cancel-probe' } })}\n`)
process.on('SIGTERM', () => {})
const child = spawn(process.execPath, ['-e',
  'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},60000)',
], { stdio: ['ignore', 'pipe', 'ignore'] })
await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve) })
const pending = `${readyPath}.pending`
await writeFile(pending, JSON.stringify({ worker: process.pid, child: child.pid }))
await rename(pending, readyPath)
setInterval(() => {}, 60000)
