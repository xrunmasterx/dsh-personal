import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('retains both Personal welcome messages in the version-pinned native Conversation', async () => {
  const dsh = createRequire(realpathSync(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)))
  const web = createRequire(dsh.resolve('@deepseek-ai/dsh-web-app'))
  const source = await readFile(web.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8')
  expect(source).toContain('"hero.headline": "今天想推进什么？"')
  expect(source).toContain('"hero.headline": "What would you like to move forward today?"')
})
