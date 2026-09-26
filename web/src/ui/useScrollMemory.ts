import { useEffect, useRef, useState } from 'react'
import { db } from '../db/db.ts'

/**
 * Put a scrolling list back where it was. See DESIGN.md §6 — the `uiState`
 * record is the other half of "a reload returns to exactly the same state":
 * the session covers the review, this covers everything you were looking at.
 *
 * Restored once, after the rows exist; saved on scroll, throttled through a
 * frame so a flick does not write on every event.
 *
 * A callback ref rather than a `useRef`, because the list is not in the tree on
 * the first commit: the screen renders a placeholder until Dexie answers. An
 * effect keyed on `key` alone ran once against a null ref and never again, so
 * neither the restore nor the listener ever happened. The element itself has to
 * be the dependency.
 */
export function useScrollMemory(key: string): (el: HTMLDivElement | null) => void {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const restored = useRef(false)

  useEffect(() => {
    if (!el) return

    let frame = 0
    let live = true
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        void db.ui.put({ key, value: el.scrollTop })
      })
    }

    void db.ui.get(key).then((row) => {
      // The read is async, so the list may already be gone by the time it
      // lands — attaching then would leak a listener the cleanup has run past.
      if (!live) return
      if (!restored.current && typeof row?.value === 'number') el.scrollTop = row.value
      restored.current = true
      el.addEventListener('scroll', onScroll, { passive: true })
    })

    return () => {
      live = false
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [key, el])

  return setEl
}
