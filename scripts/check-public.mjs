/** Reject accidentally tracked private configuration and recognizable credentials. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const problems = []
for (const file of files) {
  if (/(^|\/)(\.env(?:\..+)?|\.credentials\.yaml|settings\.yaml|personal-migration\.json)$/.test(file)
      && !file.endsWith('.env.example')) problems.push(`${file}: private configuration`)
  if (/(^|\/)(backups|\.local|\.dsh-home|storages|sessions|attachments|node_modules(?:\.[^/]+)?)\//.test(file)) problems.push(`${file}: private or generated directory`)
  const text = await readFile(file, 'utf8')
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{25,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-[A-Za-z0-9]{30,}/.test(text))
    problems.push(`${file}: credential-like text`)
}
if (problems.length) throw new Error(problems.join('\n'))
console.log(`Public source check: ${files.length} tracked files; no private configuration or recognized credentials.`)
