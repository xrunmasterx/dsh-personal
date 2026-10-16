/** Fingerprint install inputs and Personal source, excluding data and build output. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0'))]
  .filter(name => /^(packages\/|patches\/|scripts\/|package.json$|pnpm-|tsconfig|Open-Personal)/.test(name)).sort()
const hash = createHash('sha256')
for (const file of files) { hash.update(file); hash.update(await readFile(file)) }
console.log(hash.digest('hex'))
