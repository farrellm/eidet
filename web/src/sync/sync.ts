/**
 * The sync engine. See DESIGN.md §6.
 *
 * Reconciles the local store with the server. Nothing in the review path waits
 * on this — a review is complete the moment it is in IndexedDB, and this loop
 * catches up whenever the server happens to be reachable.
 *
 * Pull applies server rows *without* clobbering local edits: a row still in the
 * outbox has unsent changes, so an incoming copy of it is skipped and the local
 * version wins on the next push. That single rule is what keeps a sync from
 * erasing work done offline.
 */
import type { ChangeSet, PullResponse } from '@eidet/shared'
import { db, type SyncState } from '../db/db.ts'
import { downloadMissing, uploadPending } from './blobs.ts'

const ENDPOINT = '/api/changes'

export type SyncStatus = 'idle' | 'syncing' | 'offline'

/** Thrown when the request never reached the server, as distinct from a refusal. */
export class NetworkError extends Error {}

async function state(): Promise<SyncState> {
  return (
    (await db.sync.get('sync')) ?? {
      key: 'sync',
      cursor: 0,
      lastPulledAt: null,
      lastPushedAt: null,
    }
  )
}

async function request(input: string, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (err) {
    throw new NetworkError(String(err))
  }
  if (!response.ok) throw new Error(`${input}: ${response.status}`)
  return response
}

/**
 * The reachability probe (§6). Deliberately its own endpoint and deliberately
 * out of every runtime cache: asking the service worker whether the app shell
 * is available would have an offline device answer yes.
 */
export async function reachable(): Promise<boolean> {
  try {
    await request('/api/healthz')
    return true
  } catch {
    return false
  }
}

/** Everything the outbox says is dirty, read back out of its own table. */
async function collectOutbox(): Promise<ChangeSet> {
  const entries = await db.outbox.toArray()
  const ids = (table: string) => entries.filter((e) => e.table === table).map((e) => e.rowId)
  const [decks, cards, reviews, paramSets] = await Promise.all([
    db.decks.bulkGet(ids('decks')),
    db.cards.bulkGet(ids('cards')),
    db.reviews.bulkGet(ids('reviews')),
    db.paramSets.bulkGet(ids('paramSets')),
  ])
  return {
    decks: decks.filter(Boolean) as ChangeSet['decks'],
    cards: cards.filter(Boolean) as ChangeSet['cards'],
    reviews: reviews.filter(Boolean) as ChangeSet['reviews'],
    paramSets: paramSets.filter(Boolean) as ChangeSet['paramSets'],
  }
}

export async function pushChanges(): Promise<number> {
  const outbox = await db.outbox.toArray()
  if (outbox.length === 0) return 0
  const changes = await collectOutbox()
  await request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changes),
  })
  // Clear only what was actually sent, so an edit made mid-request is not lost.
  await db.outbox.bulkDelete(outbox.map((e) => e.id))
  await db.sync.put({ ...(await state()), lastPushedAt: Date.now() })
  return outbox.length
}

export async function pullChanges(): Promise<string[]> {
  const before = await state()
  const response = await request(`${ENDPOINT}?since=${before.cursor}`)
  const payload = (await response.json()) as PullResponse

  // A row with unsent local edits is not overwritten by the server's copy.
  const dirty = new Set((await db.outbox.toArray()).map((e) => e.id))
  const keep = <T extends { id: string }>(table: string, rows: T[]) =>
    rows.filter((r) => !dirty.has(`${table}:${r.id}`))

  const decks = keep('decks', payload.decks)
  const cards = keep('cards', payload.cards)

  await db.transaction('rw', db.decks, db.cards, db.reviews, db.paramSets, db.sync, async () => {
    if (decks.length) await db.decks.bulkPut(decks)
    if (cards.length) await db.cards.bulkPut(cards)
    // Reviews are immutable, so an incoming copy of one already held is
    // identical by construction and safe to write.
    if (payload.reviews.length) await db.reviews.bulkPut(payload.reviews)
    if (payload.paramSets.length) await db.paramSets.bulkPut(payload.paramSets)
    await db.sync.put({ ...before, cursor: payload.seq, lastPulledAt: Date.now() })
  })

  return payload.reviews.map((r) => r.sideId)
}

/**
 * Memories are derived, so they are never synced — they are recomputed from
 * whatever reviews arrived. Taking the newest review's snapshot rather than
 * replaying is what makes this cheap, and it reproduces exactly what the device
 * that did the reviewing computed, fuzz included (§2).
 */
export async function rebuildMemoriesFrom(sideIds: string[]) {
  for (const sideId of new Set(sideIds)) {
    const newest = await db.reviews.where('sideId').equals(sideId).sortBy('reviewedAt')
    const last = newest.at(-1)
    if (last) await db.memories.put(last.memoryAfter)
  }
}

export async function syncOnce(): Promise<{ pushed: number; pulled: number; blobs: number }> {
  // Probe before doing anything expensive: an unreachable server should cost a
  // single small request, not a multi-megabyte push that fails slowly.
  if (!(await reachable())) throw new NetworkError('/api/healthz unreachable')

  const pushed = await pushChanges()
  const touchedSides = await pullChanges()
  await rebuildMemoriesFrom(touchedSides)
  // Images go last and in small batches: a review must never queue behind a photo.
  const blobs = (await uploadPending()) + (await downloadMissing())
  return { pushed, pulled: touchedSides.length, blobs }
}
