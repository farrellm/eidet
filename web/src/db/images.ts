/**
 * Images, on the way into the local blob store. See DESIGN.md §5, §6.
 *
 * Downscaled on the phone before it is ever stored, then content-addressed by
 * SHA-256 so the same photo used twice costs one blob and can be cached
 * forever. The server verifies the same digest before it accepts the bytes.
 */
import type { Sha256 } from '@eidet/shared'
import { db } from './db.ts'

const MAX_EDGE = 1600

export async function sha256Hex(data: ArrayBuffer): Promise<Sha256> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function downscale(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
  return { blob, width, height }
}

export async function storeImage(file: File, now = Date.now()): Promise<Sha256> {
  const { blob, width, height } = await downscale(file)
  const sha256 = await sha256Hex(await blob.arrayBuffer())
  const existing = await db.blobs.get(sha256)
  if (!existing) {
    await db.blobs.put({
      sha256,
      mime: blob.type,
      bytes: blob.size,
      width,
      height,
      createdAt: now,
      data: blob,
      uploaded: 0,
    })
  }
  return sha256
}
