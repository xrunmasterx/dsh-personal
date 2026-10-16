/** Minimal per-call Codex settings and a private login snapshot, without global histories or extensions. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { z } from 'zod'

const settingsSchema = z.object({
  model_providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  chatgpt_base_url: z.string().optional(),
  cli_auth_credentials_store: z.enum(['file', 'keyring', 'auto', 'ephemeral']).optional(),
})

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Initialize an already-created private directory from file-backed local login and one provider.
 * @param source - existing Codex home, read-only throughout preparation and execution.
 * @param target - empty per-call cache directory removed after the worker tree exits.
 * @param provider - selected provider; unrelated configuration and extensions are omitted.
 */
export async function prepareCodexHome(source: string, target: string, provider: string): Promise<void> {
  const text = await optionalFile(join(source, 'config.toml'))
  const settings = settingsSchema.parse(text === null ? {} : parse(text))
  if (settings.cli_auth_credentials_store === 'keyring')
    throw new Error(
      'Isolated workflow execution requires a file-backed Codex login or a provider environment credential; keyring-only login cannot be copied',
    )
  const selected = settings.model_providers?.[provider]
  await writeFile(
    join(target, 'config.toml'),
    stringify({
      cli_auth_credentials_store: 'file',
      ...(selected ? { model_providers: { [provider]: selected } } : {}),
      ...(settings.chatgpt_base_url ? { chatgpt_base_url: settings.chatgpt_base_url } : {}),
    }),
    { flag: 'wx', mode: 0o600 },
  )
  const auth = await optionalFile(join(source, 'auth.json'))
  if (auth !== null) await writeFile(join(target, 'auth.json'), auth, { flag: 'wx', mode: 0o600 })
}
