/** Validate coupled runtime packages and artifacts before changing a profile. */
import { readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const requiredArtifacts = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  ...['index', 'invariant', 'tools', 'codex-worker', 'import-cli', 'typert.host', 'typert.remote-client'].map(name => `packages/host/lib/${name}.js`),
  'packages/host/lib/types/client.js',
  ...['api', 'client'].flatMap(name => [`packages/${name}/lib/index.js`, `packages/${name}/lib/client.js`]),
  'packages/personal/lib/index.js',
]

export async function checkRuntime(root) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Personal requires Node.js 24 or newer')
  const compatibility = JSON.parse(await readFile(join(root, 'compatibility.json'), 'utf8'))
  const cli = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  const dsh = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== compatibility.dshVersion)
    throw new Error(`This Personal release supports official DSH ${compatibility.dshVersion}; found ${dsh.name}@${dsh.version}`)
  for (const name of ['host', 'api', 'client', 'personal']) {
    const pkg = JSON.parse(await readFile(join(root, `packages/${name}/package.json`), 'utf8'))
    if (pkg.version !== compatibility.personalVersion) throw new Error(`Personal ${name} version differs from compatibility.json`)
  }
  for (const name of requiredArtifacts) await access(join(root, name))
  return { cli, compatibility }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--root' || !process.argv[3]) throw new Error('Use --root <runtime directory>')
  await checkRuntime(resolve(process.argv[3]))
}
