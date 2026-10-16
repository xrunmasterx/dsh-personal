/** Copy only Git-visible source into an isolated, immutable runtime directory. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, lstat, cp, rm, access, readdir } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export async function sourceFiles(root) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(name =>
    /^(?:packages\/|patches\/|scripts\/|docs\/|\.github\/|(?:package\.json|pnpm-[^/]+|tsconfig[^/]+|vitest\.config\.ts|\.npmrc|\.gitignore|\.gitattributes|README(?:\.en)?\.md|LICENSE|AGENTS\.md|compatibility\.json|Open-Personal\.(?:ps1|cmd))$)/.test(name)))].sort()
}

export async function sourceStamp(root) {
  const hash = createHash('sha256')
  for (const name of await sourceFiles(root)) {
    hash.update(name); hash.update(await readFile(join(root, name)))
  }
  return hash.digest('hex')
}

export async function prepareRelease(root, target) {
  await mkdir(target, { recursive: false })
  const stamp = await sourceStamp(root)
  for (const name of await sourceFiles(root)) {
    const from = join(root, name), to = join(target, name)
    if (!(await lstat(from)).isFile()) throw new Error(`Release source must be a regular file: ${name}`)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to)
  }
  if (await sourceStamp(root) !== stamp || await copiedStamp(target, await sourceFiles(root)) !== stamp)
    throw new Error('Source changed while preparing the release; save changes and retry')
  await writeFile(join(target, 'personal-release.json'), JSON.stringify({ source: root, stamp }) + '\n')
}

async function copiedStamp(root, files) {
  const hash = createHash('sha256')
  for (const name of files) { hash.update(name); hash.update(await readFile(join(root, name))) }
  return hash.digest('hex')
}

/** Checkpoint only profile configuration and links; business data is never replaced on rollback. */
export async function checkpointProfile(home, backup, restore = false) {
  home = resolve(home); backup = resolve(backup)
  const within = relative(home, backup)
  if (!within || (!isAbsolute(within) && !within.startsWith('..')))
    throw new Error('Profile checkpoint must be outside the data home')
  const names = ['profiles/personal', 'personal-installation.json']
  if (!restore) {
    await mkdir(backup)
    for (const name of names) {
      try { await access(join(home, name)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      await cp(join(home, name), join(backup, name), { recursive: true, verbatimSymlinks: true })
    }
    await writeFile(join(backup, 'checkpoint.json'), JSON.stringify({ home }) + '\n')
  } else {
    const saved = JSON.parse(await readFile(join(backup, 'checkpoint.json'), 'utf8'))
    if (saved.home !== home) throw new Error('Profile checkpoint belongs to a different data home')
    for (const name of names) {
      // Both targets are fixed descendants of the explicitly supplied data home.
      await rm(join(home, name), { recursive: true, force: true })
      try { await access(join(backup, name)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      await cp(join(backup, name), join(home, name), { recursive: true, verbatimSymlinks: true })
    }
  }
}

/** Remove obsolete launcher-owned builds after keeping the current and previous runtime. */
export async function pruneReleases(root, directory, keep) {
  const retained = keep.map(path => resolve(path))
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^release-[a-f0-9]{32}$/.test(entry.name)) continue
    const target = resolve(directory, entry.name)
    if (retained.includes(target)) continue
    let saved
    try { saved = JSON.parse(await readFile(join(target, 'personal-release.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (resolve(saved.source) !== resolve(root)) continue
    // Only direct, non-symlink release directories with this launcher's marker are removed.
    await rm(target, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, target: { type: 'string' },
    home: { type: 'string' }, backup: { type: 'string' }, restore: { type: 'boolean' },
    prune: { type: 'string' }, keep: { type: 'string', multiple: true } } })
  if (values.root && values.target) await prepareRelease(resolve(values.root), resolve(values.target))
  else if (values.home && values.backup) await checkpointProfile(values.home, values.backup, values.restore)
  else if (values.root && values.prune) await pruneReleases(values.root, values.prune, values.keep ?? [])
  else throw new Error('Use --root --target or --home --backup [--restore]')
}
