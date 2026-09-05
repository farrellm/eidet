/** Renders a side's content: text as text, an image from the local blob store. */
import { useEffect, useState } from 'react'
import type { Side } from '@eidet/shared'
import { db } from '../db/db.ts'

export function SideValue({ side, inline = false }: { side: Side; inline?: boolean }) {
  if (side.kind === 'image') return <SideImage sha256={side.value} inline={inline} />
  return <>{side.value}</>
}

function SideImage({ sha256, inline }: { sha256: string; inline: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoked = false
    let created: string | null = null
    db.blobs.get(sha256).then((row) => {
      if (!row || revoked) return
      created = URL.createObjectURL(row.data)
      setUrl(created)
    })
    return () => {
      revoked = true
      if (created) URL.revokeObjectURL(created)
    }
  }, [sha256])

  if (!url) return <span className="label">Image not on this device yet.</span>
  return <img className={inline ? 'side-img side-img--inline' : 'side-img'} src={url} alt="" />
}
