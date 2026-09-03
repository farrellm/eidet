/**
 * Runs the sync loop for the app's lifetime and reports its state.
 *
 * Offline is a state, not an error: a failed request means the server is out of
 * reach, the work stays queued, and the loop simply tries again sooner.
 */
import { useEffect, useState } from 'react'
import { onDirty } from '../db/db.ts'
import { syncOnce, type SyncStatus } from './sync.ts'

const ONLINE_EVERY = 30_000
const OFFLINE_EVERY = 8_000
/** Coalesce a burst of writes — saving a card queues several rows at once. */
const AFTER_WRITE = 700

export function useSync(): { status: SyncStatus; lastSyncedAt: number | null } {
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let running = false

    const run = async () => {
      if (stopped || running) return
      running = true
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
        clearTimeout(timer)
        timer = setTimeout(run, delay)
      }
    }

    const schedule = (delay: number) => {
      if (stopped) return
      clearTimeout(timer)
      timer = setTimeout(run, delay)
    }

    void run()
    const wake = () => schedule(0)
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    const stopListening = onDirty(() => schedule(AFTER_WRITE))

    return () => {
      stopped = true
      clearTimeout(timer)
      stopListening()
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  return { status, lastSyncedAt }
}
