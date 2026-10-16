/** Start the official DSH Web app with the Personal profile. */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { checkRuntime } from './runtime.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { home: { type: 'string' }, port: { type: 'string', default: '3081' }, 'no-open': { type: 'boolean' } } })
const home = resolve(values.home ?? join(homedir(), '.dsh-personal'))
const installation = JSON.parse(await readFile(join(home, 'personal-installation.json'), 'utf8'))
if (resolve(installation.source) !== resolve(root))
  throw new Error('This data home is linked to a different checkout. Run this checkout\'s scripts/install.mjs --home first, or start the installed checkout.')
const { cli } = await checkRuntime(root)
let sourceRoot = root
try { sourceRoot = JSON.parse(await readFile(join(root, 'personal-release.json'), 'utf8')).source }
catch (error) { if (error.code !== 'ENOENT') throw error }
const child = spawn(process.execPath, [cli, '--profile', 'personal',
  '--host', '127.0.0.1', '--port', values.port, ...(values['no-open'] ? ['--no-open'] : [])],
{ stdio: 'inherit', env: { ...process.env, DSH_HOME: home, PERSONAL_SOURCE_ROOT: process.env.PERSONAL_SOURCE_ROOT ?? sourceRoot } })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
