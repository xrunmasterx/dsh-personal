import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import { installBriefSettings } from '../src/brief-settings.ts'
import { config } from './helpers.ts'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable() { return true }
  protected async load() { return this.doc }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>) { this.doc[ns] = structuredClone(section) }
}

describe('task editor model preference', () => {
  it('samples live settings atomically without changing an in-flight policy or Agent defaults', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(MemorySettings)
      const base = config('/unused').briefPolish
      let read = () => base
      const owner = ctx.plugin({ name: 'editor-settings-test', apply(ownerCtx: Context) { read = installBriefSettings(ownerCtx, base) } })
      await owner
      const first = read()
      await ctx.settings.update('personal-workbench-polish', { model: { provider: 'tencent-copilot', model: 'deepseek-v4-flash-ioa' } })
      expect(read()).toEqual({ ...base, provider: 'tencent-copilot', model: 'deepseek-v4-flash-ioa' })
      expect(first).toEqual(base)
      expect(ctx.settings.get('agent-default-model')).toBeUndefined()
      expect(ctx.settings.describe().some(section => section.ns === 'personal-workbench-polish')).toBe(true)
      await owner.dispose()
      expect(ctx.settings.describe().some(section => section.ns === 'personal-workbench-polish')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })
})
