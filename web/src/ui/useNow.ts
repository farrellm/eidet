import { useEffect, useState } from 'react'

/**
 * The clock, as state. Retrievability and "due" are functions of time, so a
 * screen that reads `Date.now()` while rendering is impure — and it also goes
 * stale, since nothing re-renders it as time passes: "Nothing due" stayed up
 * after a side fell due until something else happened to redraw the screen.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}
