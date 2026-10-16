import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('installs into a new home and reuses the same profile on repeated installation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'personal-install-'))
  const root = fileURLToPath(new URL('..', import.meta.url))
  try {
    for (let i = 0; i < 2; i++) {
      const result = spawnSync(process.execPath, ['scripts/install.mjs', '--home', home], {
        cwd: root, encoding: 'utf8', timeout: 30000,
      })
      expect(result.status, result.stderr || result.error?.message).toBe(0)
    }
    const profile = JSON.parse(await readFile(join(home, 'profiles/personal/package.json'), 'utf8'))
    expect(profile.dsh.profile.bundles).toContain('@xrunmasterx/dsh-personal')
    expect(await readFile(join(home, 'profiles/personal/cordis.patch.yml'), 'utf8')).toContain('[]')
  } finally { await rm(home, { recursive: true, force: true }) }
})
