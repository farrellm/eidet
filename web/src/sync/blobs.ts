/**
 * Image upload, on its own queue. See DESIGN.md §6.
 *
 * Separate from the change queue on purpose: a photo is orders of magnitude
 * bigger than a review, and a slow upload must never hold up the reviews behind
 * it. Uploads are idempotent — the server verifies the digest and ignores a
 * blob it already holds — so a retry after a dropped connection costs nothing.
 */
import { db } from '../db/db.ts'

export async function uploadPending(limit = 3): Promise<number> {
  const pending = await db.blobs.where('uploaded').equals(0).limit(limit).toArray()
  let done = 0
  for (const blob of pending) {
    const response = await fetch(`/api/blobs/${blob.sha256}`, {
      method: 'PUT',
      headers: {
        'content-type': blob.mime,
        'x-image-width': String(blob.width),
        'x-image-height': String(blob.height),
      },
      body: blob.data,
    })
    if (!response.ok) break
    await db.blobs.update(blob.sha256, { uploaded: 1 })
    done++
  }
  return done
}

/** Fetch a blob referenced by a synced card that this device has never seen. */
export async function fetchMissing(sha256: string): Promise<boolean> {
  if (await db.blobs.get(sha256)) return true
  const response = await fetch(`/api/blobs/${sha256}`)
  if (!response.ok) return false
  const data = await response.blob()
  await db.blobs.put({
    sha256,
    mime: data.type,
    bytes: data.size,
    width: 0,
    height: 0,
    createdAt: Date.now(),
    data,
    uploaded: 1,
  })
  return true
}
