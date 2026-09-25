/**
 * Picking an image for a side. See DESIGN.md §4. Storing it is `storeImage`'s
 * job; upload happens later, on the blob queue — never in this path.
 */
import { useState } from 'react'
import type { Side } from '@eidet/shared'
import { storeImage } from '../db/images.ts'
import { SideValue } from './SideValue.tsx'

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
