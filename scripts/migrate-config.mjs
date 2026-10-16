/** Preserve the legacy host configuration while relocating its owned writable files. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { parseDocument, YAMLSeq, isScalar, visit } from 'yaml'

/** Import the legacy host row only into an otherwise unconfigured Personal profile. */
export async function migrateProfileConfig(home) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(home, 'personal-migration.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  const target = join(home, 'profiles/personal/cordis.patch.yml')
  const output = parseDocument(await readFile(target, 'utf8'))
  if (!(output.contents instanceof YAMLSeq) || output.contents.items.length !== 0) return
  const source = parseDocument(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  if (source.errors.length) throw new Error('Legacy profile YAML could not be read')
  if (!(source.contents instanceof YAMLSeq)) throw new Error('Legacy profile patch must be a list')
  const rows = source.contents.items.filter(row => row?.get?.('id') === 'personal-workbench-host')
  if (rows.length !== 1) throw new Error('Expected one legacy Personal host configuration')
  const row = rows[0].clone()
  row.delete('name')
  const config = row.get('config', true)
  if (!config) throw new Error('Legacy Personal host configuration is missing')
  // Screenshots and investigation artifacts are copied under this home by migrate.mjs.
  config.set('dataRoot', join(home, 'personal-workbench'))
  visit(config, (_, node) => {
    if (isScalar(node) && typeof node.value === 'string' && isAbsolute(node.value)) {
      const previous = manifest.source
      if (node.value === previous || node.value.startsWith(previous + '/') || node.value.startsWith(previous + '\\'))
        node.value = home + node.value.slice(previous.length)
    }
  })
  output.contents.items.push(row)
  await writeFile(target, output.toString())
}
