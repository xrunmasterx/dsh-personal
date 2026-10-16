import { migrateProfileConfig } from './migrate-config.mjs'
import { checkRuntime } from './runtime.mjs'
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
const { cli, compatibility } = await checkRuntime(root)
if (values['dsh-cli'] && resolve(values['dsh-cli']) !== cli) throw new Error('Use the pinned DSH installed by this repository; external CLI installations cannot guarantee the welcome compatibility patch')
await mkdir(home, { recursive: true })
const env = { ...process.env, DSH_HOME: home }
function run(args, quiet = false) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`DSH installation failed (${result.status}): ${quiet ? result.stderr : ''}`)
}
let existing = false
try { await access(join(home, 'profiles/personal/package.json')); existing = true }
catch (error) { if (error.code !== 'ENOENT') throw error }
run(['--profile', 'personal', ...(existing ? [] : ['--from-default-profile', 'web']), '--dump-config'], true)
// The CLI runs pnpm from this profile, outside the repository's package-manager pin.
const profileManifest = join(home, 'profiles/personal/package.json')
const profile = JSON.parse(await readFile(profileManifest, 'utf8'))
profile.packageManager = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager
// Store the filesystem spec as JSON: 0.1.6's Windows CLI forwards add arguments through a shell.
profile.dependencies = { ...profile.dependencies, '@xrunmasterx/dsh-personal': `link:${join(root, 'packages/personal').replaceAll('\\', '/')}` }
await writeFile(profileManifest, JSON.stringify(profile, null, 2) + '\n')
run(['plugin', '--profile', 'personal', 'install'])
await migrateProfileConfig(home)
await writeFile(join(home, 'personal-installation.json'), JSON.stringify({ repository: 'https://github.com/xrunmasterx/dsh-personal',
  cli, personalVersion: compatibility.personalVersion, dshVersion: compatibility.dshVersion, source: root, installedAt: new Date().toISOString() }, null, 2) + '\n')
console.log(`Installed Personal. Start: node scripts/start.mjs --home ${JSON.stringify(home)}`)
