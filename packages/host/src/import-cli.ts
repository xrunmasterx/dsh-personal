#!/usr/bin/env node
/** Explicit offline cutover command; the workbench Host must be stopped during import. */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { importLegacy } from './migration.ts'
import { WorkbenchStore } from './store.ts'

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    'data-root': { type: 'string' },
    'storage-root': { type: 'string' },
    'source-code-root': { type: 'string' },
    connection: { type: 'string' },
    'max-result-bytes': { type: 'string' },
  },
})
function absoluteOption(key: 'source' | 'data-root' | 'storage-root' | 'source-code-root'): string {
  const value = values[key]
  if (!value || !isAbsolute(value)) throw new Error(`--${key} requires an explicit absolute directory`)
  return value
}
const sourceRoot = absoluteOption('source')
const dataRoot = absoluteOption('data-root')
const storageRoot = absoluteOption('storage-root')
const sourceCodeRoot = absoluteOption('source-code-root')
if (!values.connection || !/^[a-zA-Z0-9_-]+$/.test(values.connection))
  throw new Error('--connection requires the workbench connection identity')
const maxResultBytes = Number(values['max-result-bytes'])
if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes <= 0)
  throw new Error('--max-result-bytes requires a positive integer')
const ctx = new Context()
try {
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: storageRoot })
  await ctx.plugin(Domain, { backend: 'json', routes: {} })
  const store = await WorkbenchStore.open(ctx)
  try {
    const result = await importLegacy({
      sourceRoot,
      dataRoot,
      sourceCodeRoot,
      connectionId: values.connection,
      maxResultBytes,
      store,
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await store.close()
  }
} finally {
  await ctx.fiber.dispose()
}
