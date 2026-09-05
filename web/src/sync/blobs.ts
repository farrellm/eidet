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

/**
 * Pull down blobs that arrived by reference. A card synced from another device
 * names its images by digest, but the bytes travel on their own queue, so
 * without this pass the image side renders "not on this device yet" forever.
 *
 * It scans every local card rather than only the ones just pulled, so a
 * download that failed on an earlier pass is retried on the next one instead of
 * being stranded. Bounded per pass for the same reason uploads are: a review
 * must never queue behind a photo.
 */
export async function downloadMissing(limit = 3): Promise<number> {
  const cards = await db.cards.toArray()
  const wanted = new Set<string>()
  for (const card of cards) {
    if (card.deletedAt !== null) continue
    for (const side of card.sides) {
      if (side.kind === 'image' && side.value) wanted.add(side.value)
    }
  }
  if (wanted.size === 0) return 0

  const held = new Set(await db.blobs.where('sha256').anyOf([...wanted]).primaryKeys())
  let done = 0
  for (const sha256 of wanted) {
    if (done >= limit) break
    if (held.has(sha256)) continue
    if (!(await fetchMissing(sha256))) break
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
