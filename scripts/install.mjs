import { migrateProfileConfig } from './migrate-config.mjs'
/** Install the built bundle into a dedicated profile using the official DSH CLI. */
import { spawnSync } from 'node:child_process'
import { readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: { home: { type: 'string' }, 'dsh-cli': { type: 'string' } } })
const home = resolve(values.home ?? join(homedir(), '.dsh-personal'))
const cli = resolve(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
if (values['dsh-cli'] && resolve(values['dsh-cli']) !== cli) throw new Error('Use the pinned DSH installed by this repository; external CLI installations cannot guarantee the welcome compatibility patch')
const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
const host = JSON.parse(await readFile(resolve(cli, '../../package.json'), 'utf8'))
if (host.name !== '@deepseek-ai/dsh' || host.version !== compatibility.dshVersion)
  throw new Error(`This Personal release supports official DSH ${compatibility.dshVersion}; found ${host.name}@${host.version}`)
for (const name of ['host', 'api', 'client', 'personal']) await access(join(root, `packages/${name}/lib/index.js`))
for (const name of ['api', 'client']) await access(join(root, `packages/${name}/lib/client.js`))
await mkdir(home, { recursive: true })
const env = { ...process.env, DSH_HOME: home }
function run(args, quiet = false) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`DSH installation failed (${result.status}): ${quiet ? result.stderr : ''}`)
}
run(['--profile', 'personal', '--from-default-profile', 'web', '--dump-config'], true)
run(['plugin', '--profile', 'personal', 'add', `link:${join(root, 'packages/personal')}`])
await migrateProfileConfig(home)
await writeFile(join(home, 'personal-installation.json'), JSON.stringify({ repository: 'https://github.com/xrunmasterx/dsh-personal',
  cli, personalVersion: compatibility.personalVersion, dshVersion: host.version, source: root, installedAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`Installed Personal. Start: node scripts/start.mjs --home ${JSON.stringify(home)}`)
