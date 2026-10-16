import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { sourceStamp, prepareRelease, checkpointProfile, pruneReleases } from './release.mjs'

it('builds from a self-contained source snapshot without dependencies, private data or the original Git checkout', async () => {
  const area = await mkdtemp(join(tmpdir(), 'personal release '))
  const root = join(area, 'source'), release = join(area, 'release')
  await mkdir(root)
  try {
    execFileSync('git', ['init', '-q', root])
    await writeFile(join(root, '.gitignore'), '.local/\nnode_modules/\n')
    await writeFile(join(root, 'compatibility.json'), 'first')
    await mkdir(join(root, '.local')); await writeFile(join(root, '.local/private.json'), 'private')
    await mkdir(join(root, 'private home')); await writeFile(join(root, 'private home/settings.yaml'), 'private')
    const first = await sourceStamp(root)
    await writeFile(join(root, 'compatibility.json'), 'second')
    expect(await sourceStamp(root)).not.toBe(first)
    const beforePrivateChange = await sourceStamp(root)
    await writeFile(join(root, 'private home/settings.yaml'), 'new private work')
    expect(await sourceStamp(root)).toBe(beforePrivateChange)
    await prepareRelease(root, release)
    await rm(root, { recursive: true })
    expect(await readFile(join(release, 'compatibility.json'), 'utf8')).toBe('second')
    await expect(readFile(join(release, '.local/private.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(release, '.git/config'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(release, 'private home/settings.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(area, { recursive: true, force: true }) }
})

it('prunes only marked obsolete builds and keeps both the active and rollback runtime', async () => {
  const area = await mkdtemp(join(tmpdir(), 'personal releases '))
  try {
    const dirs = ['a', 'b', 'c', 'd'].map(char => join(area, 'release-' + char.repeat(32)))
    for (const dir of dirs) { await mkdir(dir); await writeFile(join(dir, 'personal-release.json'), JSON.stringify({ source: area })) }
    await writeFile(join(dirs[3], 'personal-release.json'), JSON.stringify({ source: join(area, 'another checkout') }))
    await pruneReleases(area, area, dirs.slice(0, 2))
    for (const dir of [dirs[0], dirs[1], dirs[3]]) expect(await readFile(join(dir, 'personal-release.json'), 'utf8')).toBeTruthy()
    await expect(readFile(join(dirs[2], 'personal-release.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(area, { recursive: true, force: true }) }
})

it('restores an interrupted profile switch without replacing newer tasks or following package links', async () => {
  const area = await mkdtemp(join(tmpdir(), 'personal rollback '))
  const home = join(area, 'home'), backup = join(area, 'checkpoint'), external = join(area, 'runtime')
  await mkdir(join(home, 'profiles/personal/node_modules'), { recursive: true })
  await mkdir(external)
  try {
    await writeFile(join(external, 'index.js'), 'original runtime')
    await symlink(external, join(home, 'profiles/personal/node_modules/plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(home, 'profiles/personal/cordis.patch.yml'), 'original settings')
    await writeFile(join(home, 'personal-installation.json'), 'original installation')
    await checkpointProfile(home, backup)
    await writeFile(join(home, 'tasks.json'), 'new work')
    await writeFile(join(home, 'profiles/personal/cordis.patch.yml'), 'incomplete update')
    await checkpointProfile(home, backup, true)
    expect(await readFile(join(home, 'profiles/personal/cordis.patch.yml'), 'utf8')).toBe('original settings')
    expect(await readFile(join(home, 'tasks.json'), 'utf8')).toBe('new work')
    expect(await readFile(join(home, 'personal-installation.json'), 'utf8')).toBe('original installation')
    expect(await readFile(join(external, 'index.js'), 'utf8')).toBe('original runtime')
    expect(await readlink(join(home, 'profiles/personal/node_modules/plugin'))).toContain('runtime')
    await expect(checkpointProfile(home, join(home, 'unsafe'))).rejects.toThrow('outside')
    await expect(checkpointProfile(join(area, 'other'), backup, true)).rejects.toThrow('different data home')
  } finally { await rm(area, { recursive: true, force: true }) }
})
