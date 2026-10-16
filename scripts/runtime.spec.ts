import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { checkRuntime, requiredArtifacts } from './runtime.mjs'

it('rejects incompatible DSH, mixed Personal versions and missing browser artifacts before installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal runtime '))
  async function file(name: string, value: string) { const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
  try {
    await file('compatibility.json', JSON.stringify({ dshVersion: '0.1.6-alpha.1', personalVersion: '0.1.0' }))
    const dsh = 'node_modules/@deepseek-ai/dsh/package.json'
    await file(dsh, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }))
    await expect(checkRuntime(root)).rejects.toThrow('supports official DSH')
    await file(dsh, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.6-alpha.1' }))
    await file('node_modules/@deepseek-ai/dsh/lib/bin.js', '')
    for (const name of ['host', 'api', 'client', 'personal']) {
      await file(`packages/${name}/package.json`, JSON.stringify({ version: '0.1.0' }))
      await file(`packages/${name}/lib/index.js`, '')
    }
    await file('packages/host/package.json', JSON.stringify({ version: '0.1.1' }))
    await expect(checkRuntime(root)).rejects.toThrow('host version differs')
    await file('packages/host/package.json', JSON.stringify({ version: '0.1.0' }))
    await expect(checkRuntime(root)).rejects.toMatchObject({ code: 'ENOENT' })
    for (const name of requiredArtifacts) await file(name, '')
    expect((await checkRuntime(root)).cli).toBe(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  } finally { await rm(root, { recursive: true, force: true }) }
})
