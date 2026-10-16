/** Durable task image destinations backed by the native attachment store. */
import { AttachmentId, admitEncodedImages, type AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'

const prefix = 'personal-image:v1:'
const dimensions = z.object({ width: z.number().int().positive(), height: z.number().int().positive() })
const reference = dimensions.extend({
  attachmentId: z.string().min(1).transform(AttachmentId),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().int().positive(), name: z.string().optional(), originalDimensions: dimensions.optional(),
}).strict()

/** Save validated raster bytes outside journal text.
 * @param store Native attachment owner.
 * @param data Canonical base64 image bytes.
 * @param mediaType Declared raster format.
 * @returns Portable Markdown destination containing metadata, never image bytes or credentials.
 */
export async function saveBriefImage(store: AttachmentStore, data: string, mediaType: string): Promise<string> {
  const format = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).parse(mediaType)
  const [ref] = await admitEncodedImages(store, [{ data, mediaType: format }])
  return prefix + Buffer.from(JSON.stringify(ref)).toString('base64url')
}

/** Resolve a saved image through the authenticated Remote connection.
 * @param store Native attachment owner.
 * @param destination Versioned task-image reference.
 * @returns Verified raster data URL for display only.
 */
export async function readBriefImage(store: AttachmentStore, destination: string): Promise<string> {
  if (!destination.startsWith(prefix) || destination.length > 4096) throw new Error('Invalid task image reference')
  const { name, originalDimensions, ...base } = reference.parse(JSON.parse(Buffer.from(destination.slice(prefix.length), 'base64url').toString('utf8')))
  const image = await store.readImage({
    ...base, ...(name === undefined ? {} : { name }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  })
  return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}
