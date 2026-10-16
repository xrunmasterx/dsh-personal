import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { expect, it } from 'vitest'
import { prepareCodexHome } from '../src/codex-home.ts'
import { harness } from './helpers.ts'

it('copies only the selected model connection and file login into an isolated Codex home', async () => {
  const h = await harness()
  const source = join(h.root, 'codex')
  const target = join(h.root, 'call')
  try {
    await mkdir(source)
    await mkdir(target)
    await mkdir(join(source, 'sessions'))
    const config =
      'developer_instructions = "unrelated instructions"\n[mcp_servers.unrelated]\ncommand = "unrelated"\n[model_providers.selected]\nname = "Fixture"\nbase_url = "https://model.example.test/v1"\nwire_api = "responses"\n[model_providers.other]\nname = "Other"\n'
    const auth = '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-only"}'
    await writeFile(join(source, 'config.toml'), config)
    await writeFile(join(source, 'auth.json'), auth)
    await prepareCodexHome(source, target, 'selected')
    expect(await readdir(target)).toEqual(['auth.json', 'config.toml'])
    expect(parse(await readFile(join(target, 'config.toml'), 'utf8'))).toEqual({
      cli_auth_credentials_store: 'file',
      model_providers: {
        selected: { name: 'Fixture', base_url: 'https://model.example.test/v1', wire_api: 'responses' },
      },
    })
    await writeFile(join(target, 'auth.json'), 'refreshed private login')
    expect(await readFile(join(source, 'auth.json'), 'utf8')).toBe(auth)
    expect(await readFile(join(source, 'config.toml'), 'utf8')).toBe(config)
  } finally {
    await h.close()
  }
})
