/** Install and boot the published DSH in an empty home, with no developer credentials or fixed port. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const { values } = parseArgs({ options: { root: { type: 'string' } } })
const root = resolve(values.root ?? fileURLToPath(new URL('..', import.meta.url)))
const area = await mkdtemp(join(tmpdir(), 'personal install smoke '))
const home = join(area, 'data'), user = join(area, 'user')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|KEY|^(?:CODEX_|DEEPSEEK_|OPENAI_|PERSONAL_|DSH_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)))
Object.assign(env, { DSH_HOME: home, HOME: user, USERPROFILE: user, APPDATA: join(user, 'AppData/Roaming'),
  LOCALAPPDATA: join(user, 'AppData/Local'), PATH: dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH })
await mkdir(env.APPDATA, { recursive: true })
let child, exited
let output = '', errors = ''
try {
  const install = spawnSync(process.execPath, ['scripts/install.mjs', '--home', home], { cwd: root, env, encoding: 'utf8', timeout: 60000 })
  assert.equal(install.status, 0, install.error?.message ?? install.stderr)
  child = spawn(process.execPath, ['node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'personal', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  exited = once(child, 'close')
  const ready = Promise.withResolvers()
  const deadline = setTimeout(() => ready.reject(new Error('Personal startup timed out')), 60000)
  child.on('error', error => ready.reject(error))
  child.once('exit', () => ready.reject(new Error('Personal exited before startup')))
  child.stderr.on('data', bytes => { errors += bytes })
  child.stdout.on('data', bytes => {
    output += bytes
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
    if (url) ready.resolve(url[0])
  })
  let url
  try { url = await ready.promise } finally { clearTimeout(deadline) }
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const origin = new URL(url).origin
  const statusDeadline = Date.now() + 60000
  for (;;) {
    const status = await fetch(origin + '/api/personal-workbench.status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    if (status.ok && (await status.json()).ready === true) break
    assert.equal(status.status, 404, 'Unexpected Personal startup response')
    if (Date.now() >= statusDeadline || child.exitCode !== null) throw new Error('Personal business API did not become ready')
    await delay(100)
  }
  const page = await fetch(origin, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  console.log('Clean-home smoke: pinned DSH, Personal business API and Web page ready; OS-assigned port; no model credentials.')
} catch (error) {
  console.error(errors.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'))
  throw error
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
  if (exited) await exited
  await rm(area, { recursive: true, force: true })
}
