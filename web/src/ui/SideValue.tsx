/** Renders a side's content: text as text, an image from the local blob store. */
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Side } from '@eidet/shared'
import { db } from '../db/db.ts'

export function SideValue({ side, inline = false }: { side: Side; inline?: boolean }) {
  if (side.kind === 'image') return <SideImage sha256={side.value} inline={inline} />
  return <>{side.value}</>
}

function SideImage({ sha256, inline }: { sha256: string; inline: boolean }) {
  // Watched live, because the bytes of a synced card's image arrive on their
  // own queue after the card does, and a one-off read left the placeholder up
  // for good. Presence rather than the blob itself: a live query hands back a
  // fresh Blob every time the table changes, which would remint the URL and
  // flash the image on every unrelated upload.
  const present = useLiveQuery(() => db.blobs.where('sha256').equals(sha256).count(), [sha256])
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!present) return
    let live = true
    let created: string | null = null
    void db.blobs.get(sha256).then((row) => {
      if (!row || !live) return
      created = URL.createObjectURL(row.data)
      setUrl(created)
    })
    return () => {
      live = false
      if (created) URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [sha256, present])

  if (!url) return <span className="label">Image not on this device yet.</span>
  return <img className={inline ? 'side-img side-img--inline' : 'side-img'} src={url} alt="" />
}
