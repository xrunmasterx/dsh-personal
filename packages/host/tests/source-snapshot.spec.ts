import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { captureSources } from '../src/source-snapshot.ts'
import { normalizeCrashStackSourcePaths } from '../src/incident/collector.ts'
import { harness } from './helpers.ts'

it('reports the installed DSH version without assuming a source checkout exists', async () => {
  const h = await harness()
  try {
    const snapshot = await captureSources(h.ctx, { ...h.config, gitSources: [] }, new AbortController().signal)
    const installed = JSON.parse(await readFile(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'))
    expect(snapshot.harnessVersion).toBe(installed.version)
    expect(snapshot.repositories).toEqual([])
  } finally { await h.close() }
})

it('normalizes build paths for any project while preserving engine paths and unknown files', () => {
  const stack = 'D:\\Build\\OtherGame\\Source\\Game\\Render.cpp:12\n' +
    'D:\\Build\\ProjectH\\Plugins\\Light\\Light.cpp:3\n' +
    '/build/unreal/Engine/Source/Runtime/Render.cpp:7\n/tmp/unknown.cpp:2'
  expect(normalizeCrashStackSourcePaths(stack)).toBe('Source/Game/Render.cpp:12\nPlugins/Light/Light.cpp:3\nEngine/Source/Runtime/Render.cpp:7\n/tmp/unknown.cpp:2')
})
