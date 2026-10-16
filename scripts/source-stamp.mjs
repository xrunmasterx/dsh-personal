/** Fingerprint install inputs and Personal source, excluding data and build output. */
import { sourceStamp } from './release.mjs'
import { fileURLToPath } from 'node:url'
console.log(await sourceStamp(fileURLToPath(new URL('..', import.meta.url))))
