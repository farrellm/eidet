/**
 * Picking an image for a side. See DESIGN.md §4.
 *
 * Downscaled on the phone before it is ever stored, then content-addressed by
 * SHA-256 so the same photo used twice costs one blob and can be cached
 * forever. Upload happens later, on the blob queue — never in this path.
 */
import { useState } from 'react'
import type { Side } from '@eidet/shared'
import { db } from '../db/db.ts'
import { SideValue } from './SideValue.tsx'

const MAX_EDGE = 1600

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
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

export async function storeImage(file: File, now = Date.now()): Promise<string> {
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

export function ImageSideInput({
  side,
  onChange,
}: {
  side: Side
  onChange: (patch: Partial<Side>) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      onChange({ value: await storeImage(file) })
    } catch {
      setError("Couldn't read that image. Try another.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field__image">
      {side.value ? <SideValue side={side} /> : null}
      <label className="action action--quiet field__pick">
        {busy ? 'Adding…' : side.value ? 'Replace image' : 'Add image'}
        <input
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </label>
      {error ? <p className="rest">{error}</p> : null}
    </div>
  )
}
