import { expect, it } from 'vitest'
import { sessionFrames, compressSessionFrame } from './session-frames.mjs'

it('reads every concatenated frame and preserves an unchanged native frame exactly', () => {
  const header = compressSessionFrame(Buffer.from('{"type":"session"}\n'))
  const events = compressSessionFrame(Buffer.from('{"type":"personal-workbench/task-context","data":{"taskId":"task"}}\n'))
  const bytes = Buffer.concat([header, events])
  const frames = sessionFrames(bytes, true)
  expect(frames).toHaveLength(2)
  expect(frames[1]?.plain.toString()).toContain('task-context')
  expect(bytes.subarray(frames[0]!.start, frames[0]!.end)).toEqual(header)
  expect(() => sessionFrames(bytes.subarray(0, bytes.length - 1), true)).toThrow()
})

it('rejects every truncation of a checksum-bearing frame instead of accepting partial plaintext', () => {
  const bytes = compressSessionFrame(Buffer.from('test data repeated '.repeat(100)))
  for (let length = 1; length < bytes.length; length++)
    expect(() => sessionFrames(bytes.subarray(0, length), true), `truncated at ${length}`).toThrow()
  expect(sessionFrames(bytes, true)[0]?.plain.toString()).toBe('test data repeated '.repeat(100))
})
