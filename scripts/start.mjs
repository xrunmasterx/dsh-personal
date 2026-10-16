/** Start the official DSH Web app with the Personal profile. */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { home: { type: 'string' }, port: { type: 'string', default: '3081' }, 'no-open': { type: 'boolean' } } })
const home = resolve(values.home ?? join(homedir(), '.dsh-personal'))
const installation = JSON.parse(await readFile(join(home, 'personal-installation.json'), 'utf8'))
const cli = installation.cli ?? join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const child = spawn(process.execPath, [cli, '--profile', 'personal',
  '--host', '127.0.0.1', '--port', values.port, ...(values['no-open'] ? ['--no-open'] : [])],
{ stdio: 'inherit', env: { ...process.env, DSH_HOME: home } })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
