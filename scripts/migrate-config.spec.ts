import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { migrateProfileConfig } from './migrate-config.mjs'

it('preserves legacy host choices, relocates writable data and leaves existing overrides intact', async () => {
  const home = await mkdtemp(join(tmpdir(), 'personal-config-'))
  try {
    await mkdir(join(home, 'profiles/web'), { recursive: true })
    await mkdir(join(home, 'profiles/personal'))
    await mkdir(join(home, 'storages/personal_workbench/evidence'), { recursive: true })
    await writeFile(join(home, 'storages/personal_workbench/evidence/latest.json'), JSON.stringify({
      version: 1, record: { createdAt: '2026-10-16T00:00:00Z', identity: { subjectId: 'fixture-person',
        displayName: 'Fixture person', role: 'Developer', projects: [], timezone: 'Asia/Shanghai', visibility: 'private' } },
    }))
    await writeFile(join(home, 'personal-migration.json'), JSON.stringify({ source: '/old-home' }))
    const source = '- id: personal-workbench-host\n  config:\n    dataRoot: /old-home/personal-workbench\n    connectionId: saved-account\n    sourceRoot: /project\n    briefPolish:\n      provider: fixture\n      model: saved-model\n    tapdUrl: !!js process.env.SOURCE_URL\n'
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), source)
    const target = join(home, 'profiles/personal/cordis.patch.yml')
    await writeFile(target, '[]\n')
    await migrateProfileConfig(home)
    const migrated = await readFile(target, 'utf8')
    expect(migrated).toContain(join(home, 'personal-workbench'))
    expect(migrated).toContain('saved-account')
    expect(migrated).toContain('saved-model')
    expect(migrated).toContain('fixture-person')
    expect(migrated).toContain('!!js process.env.SOURCE_URL')
    expect(migrated).not.toContain('/old-home')
    expect(await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')).toBe(source)
    await migrateProfileConfig(home)
    expect(await readFile(target, 'utf8')).toBe(migrated)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it.each([
  { dataRoot: '/old-home/custom/files', expected: 'custom/files' },
  { dataRoot: "!!js dshHomePath('custom/files')", expected: "dshHomePath('custom/files')" },
  { dataRoot: '/outside-home/files', expected: null },
  { dataRoot: '!!js process.env.CUSTOM_FILES', expected: null },
])('relocates a copied data root or rejects an unverified external directory: $dataRoot', async ({ dataRoot, expected }) => {
  const home = await mkdtemp(join(tmpdir(), 'personal-config-'))
  try {
    await mkdir(join(home, 'profiles/web'), { recursive: true })
    await mkdir(join(home, 'profiles/personal'))
    await writeFile(join(home, 'personal-migration.json'), JSON.stringify({ source: '/old-home' }))
    await writeFile(join(home, 'profiles/web/cordis.patch.yml'), `- id: personal-workbench-host\n  config:\n    dataRoot: ${dataRoot}\n`)
    const target = join(home, 'profiles/personal/cordis.patch.yml')
    await writeFile(target, '[]\n')
    if (expected === null) {
      await expect(migrateProfileConfig(home)).rejects.toThrow(/dataRoot/)
      expect(await readFile(target, 'utf8')).toBe('[]\n')
    } else {
      await migrateProfileConfig(home)
      expect((await readFile(target, 'utf8')).replaceAll('\\', '/')).toContain(expected)
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
