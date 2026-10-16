/** Preserve the legacy host configuration while relocating its owned writable files. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, isAbsolute, resolve, relative } from 'node:path'
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
  const dataRoot = config.get('dataRoot', true)
  if (!isScalar(dataRoot) || typeof dataRoot.value !== 'string') throw new Error('Legacy Personal dataRoot is missing')
  if (dataRoot.tag === 'tag:yaml.org,2002:js') {
    if (!/^dshHomePath\(['"][^'"]+['"]\)$/.test(dataRoot.value))
      throw new Error('Custom dataRoot expression requires an explicit migrated Personal configuration; it cannot be relocated automatically')
    const child = dataRoot.value.slice(dataRoot.value.indexOf('(') + 2, -2)
    if (relative(manifest.source, resolve(manifest.source, child)).startsWith('..') || isAbsolute(child))
      throw new Error('Legacy dataRoot is outside the copied home; copy those files before configuring Personal')
  } else {
    const child = relative(manifest.source, dataRoot.value)
    if (!isAbsolute(dataRoot.value) || child.startsWith('..') || isAbsolute(child))
      throw new Error('Legacy dataRoot is outside the copied home; copy those files before configuring Personal')
    dataRoot.value = join(home, child)
  }
  if (!config.has('profileIdentity')) {
    const directory = join(home, 'storages/personal_workbench/evidence')
    let entries = []
    try { entries = await readdir(directory) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    let latest
    for (const entry of entries.filter(name => name.endsWith('.json'))) {
      const snapshot = JSON.parse(await readFile(join(directory, entry), 'utf8')).record
      if (snapshot?.identity && (!latest || snapshot.createdAt > latest.createdAt)) latest = snapshot
    }
    if (latest) config.set('profileIdentity', latest.identity)
  }
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
