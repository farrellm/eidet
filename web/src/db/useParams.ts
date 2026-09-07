/**
 * The parameter set in force, read reactively.
 *
 * Why this is not just `useLiveQuery(currentParams)`: `currentParams` *creates*
 * the set when there isn't one, and a live query that writes to a table it also
 * reads re-triggers itself forever. On a device that already had a set the loop
 * never started, so it only surfaced on a first run — which is exactly the case
 * the e2e suite exercises. The creation happens once, in an effect; the query
 * stays a pure read.
 */
import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { ParamSet } from '@eidet/shared'
import { db } from './db.ts'
import { currentParams, upgradeParams } from './mutations.ts'

export function useCurrentParams(): ParamSet | undefined {
  useEffect(() => {
    void currentParams()
  }, [])

  return useLiveQuery(async () => {
    const stored = await db.ui.get('params')
    if (!stored) return undefined
    const set = await db.paramSets.get(stored.value as string)
    return set ? upgradeParams(set) : undefined
  }, [])
}
