/**
 * Runs the sync loop for the app's lifetime and reports its state.
 *
 * Offline is a state, not an error: a failed request means the server is out of
 * reach, the work stays queued, and the loop simply tries again sooner.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { onDirty } from '../db/db.ts'
import { syncOnce, type SyncStatus } from './sync.ts'

const ONLINE_EVERY = 30_000
const OFFLINE_EVERY = 8_000
/** Coalesce a burst of writes — saving a card queues several rows at once. */
const AFTER_WRITE = 700

export interface SyncControl {
  status: SyncStatus
  lastSyncedAt: number | null
  /** Ask for a sync right now — the manual trigger on the settings screen. */
  syncNow: () => void
}

export function useSync(): SyncControl {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const wakeNow = useRef<() => void>(() => {})

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let running = false
    let pending = false

    const run = async () => {
      if (stopped) return
      if (running) {
        // A write or a wake landed mid-flight. Re-arm rather than drop it: the
        // whole point of the nudge is that a local write reaches the server
        // promptly, and swallowing it here put the change back behind the 30 s
        // poll — the exact symptom the debounce was added to cure (§11).
        pending = true
        return
      }
      running = true
      clearTimeout(timer)
      setStatus('syncing')
      let delay = ONLINE_EVERY
      try {
        await syncOnce()
        if (!stopped) {
          setStatus('idle')
          setLastSyncedAt(Date.now())
        }
      } catch {
        // Nothing to tell the user: the work is already saved on this device.
        if (!stopped) setStatus('offline')
        delay = OFFLINE_EVERY
      }
      running = false
      if (!stopped) {
        const next = pending ? AFTER_WRITE : delay
        pending = false
        clearTimeout(timer)
        timer = setTimeout(run, next)
      }
    }

    const schedule = (delay: number) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(run, delay)
    }

    void run()
    const wake = () => schedule(0)
    wakeNow.current = wake
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    const stopListening = onDirty(() => schedule(AFTER_WRITE))

    return () => {
      stopped = true
      wakeNow.current = () => {}
      clearTimeout(timer)
      stopListening()
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  return { status, lastSyncedAt, syncNow: useCallback(() => wakeNow.current(), []) }
}
