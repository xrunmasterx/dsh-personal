/** Read every native Zstandard frame, including logs with one frame per append. */
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib'

/** Return exact frame ranges and plaintext; malformed or truncated input rejects. */
export function sessionFrames(bytes, compressed) {
  if (!compressed) return [{ start: 0, end: bytes.length, plain: bytes }]
  // Node accepts incomplete final frames. A trailing byte makes incomplete reads
  // consume beyond the original input; completed frames stop before this sentinel.
  const input = Buffer.concat([bytes, Buffer.from([0])])
  const frames = []
  let offset = 0
  while (offset < bytes.length) {
    const { buffer, engine } = zstdDecompressSync(input.subarray(offset), { info: true })
    const consumed = engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > bytes.length - offset)
      throw new Error('Invalid Zstandard session frame length')
    frames.push({ start: offset, end: offset + consumed, plain: buffer })
    offset += consumed
  }
  return frames
}

/** Emit the checksum-bearing frames accepted by native DSH session persistence. */
export function compressSessionFrame(bytes) {
  return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}
