/**
 * Sync runs for the app's lifetime, not for one screen's.
 *
 * It lives at the root because reviews are created on the review screen: a loop
 * mounted alongside the home screen stops the moment you start reviewing, which
 * is precisely when there is something to push.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { useSync, type SyncControl } from './useSync.ts'

const Context = createContext<SyncControl>({
  status: 'idle',
  lastSyncedAt: null,
  syncNow: () => {},
})

export function SyncProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useSync()}>{children}</Context.Provider>
}

export function useSyncStatus(): SyncControl {
  return useContext(Context)
}
