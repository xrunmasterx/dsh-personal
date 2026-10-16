/** Standalone build against the published DSH API; no DSH source checkout is read. */
import { build } from 'tsdown'
import { WorkspaceTypertGenerator } from './typert-tool.mjs'
import { transform } from 'lightningcss'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
function tsc(project) {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', project], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Typecheck failed: ${project}`)
}
const manifest = async name => JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'))
tsc('tsconfig.host.json')
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: false })
for (const artifact of generator.generate(['@xrunmasterx/dsh-personal-host'], ['host'])) {
  const output = resolve(root, artifact.packageRoot, 'lib')
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/typert.host.js`, artifact.js)
  await writeFile(`${output}/typert.host.d.ts`, artifact.dts)
  if (artifact.remote) {
    await writeFile(`${output}/typert.remote-client.js`, artifact.remote.js)
    await writeFile(`${output}/typert.remote-client.d.ts`, artifact.remote.dts)
    await writeFile(`${output}/typert.remote-client.d.ts.map`, artifact.remote.dtsMap)
  }
}
tsc('tsconfig.client.json')
for (const name of ['host', 'api', 'client', 'personal']) {
  const pkg = await manifest(name)
  const entries = name === 'host' ? ['index', 'invariant', 'tools', 'codex-worker', 'import-cli'] : ['index']
  await build({ config: false, entry: entries.map(entry => `packages/${name}/lib/types/${entry}.js`),
    outDir: `packages/${name}/lib`, format: 'esm', platform: 'node', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    deps: { neverBundle: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})] } })
  if (!pkg.dsh?.client) continue
  const shared = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit', ...(pkg.dsh.client.external ?? [])])
  await build({ config: false, entry: { client: `packages/${name}/lib/types/client/index.js` },
    outDir: `packages/${name}/lib`, format: 'cjs', platform: 'browser', target: 'es2024',
    fixedExtension: false, dts: false, clean: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env': '{}' },
    deps: { neverBundle: id => shared.has(id), alwaysBundle: id => !shared.has(id) },
    plugins: [{ name: 'personal-css',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        const file = resolve(dirname(importer), source).replace('/lib/types/', '/src/').replace('\\lib\\types\\', '\\src\\')
        return '\0personal-css:' + file + '.mjs'
      },
      async load(id) {
        if (!id.startsWith('\0personal-css:')) return null
        const file = id.slice('\0personal-css:'.length, -4)
        const result = transform({ filename: file, code: await readFile(file), cssModules: { pattern: '[hash]_[local]' }, minify: true })
        const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
        const tag = JSON.stringify(pkg.name + '/' + basename(file))
        return `const tag=document.createElement('style');tag.dataset.pluginCss=${tag};tag.textContent=${JSON.stringify(result.code.toString())};document.head.appendChild(tag);export default ${JSON.stringify(classes)};`
      },
    }],
    outputOptions: { entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:(require)=>{`,
      intro: 'var module={exports:{}};var exports=module.exports;', footer: 'return module.exports;}});' },
  })
}
console.log('Personal standalone Host, Remote codecs and browser bundles built.')
