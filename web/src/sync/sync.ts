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
import type { Card, ChangeSet, Deck, PullResponse, SideId } from '@eidet/shared'
import {
  db,
  newestReview,
  type Outbox,
  type OutboxTable,
  outboxKey,
  type SyncState,
  withSendLock,
} from '../db/db.ts'
import { reconcileMemories } from '../db/mutations.ts'
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

/** The rows these outbox entries name, read back out of their own tables. */
async function collectOutbox(entries: Outbox[]): Promise<ChangeSet> {
  const ids = (table: OutboxTable) => entries.filter((e) => e.table === table).map((e) => e.rowId)
  const present = <T>(rows: (T | undefined)[]) => rows.filter((r): r is T => r !== undefined)
  const [decks, cards, reviews, paramSets] = await Promise.all([
    db.decks.bulkGet(ids('decks')),
    db.cards.bulkGet(ids('cards')),
    db.reviews.bulkGet(ids('reviews')),
    db.paramSets.bulkGet(ids('paramSets')),
  ])
  return {
    decks: present(decks),
    cards: present(cards),
    reviews: present(reviews),
    paramSets: present(paramSets),
  }
}

/**
 * Clear exactly what went up. The outbox is keyed by row rather than by edit, so
 * a row touched again during the request carries a newer `queuedAt` under the
 * same key — deleting by id alone would drop that edit on the floor, which is
 * the opposite of what an outbox is for. Compare, and keep what has moved on.
 */
async function clearSent(sent: Outbox[]) {
  await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.bulkGet(sent.map((e) => e.id))
    const done = sent.filter((e, i) => current[i]?.queuedAt === e.queuedAt)
    await db.outbox.bulkDelete(done.map((e) => e.id))
  })
}

/**
 * Held under the send lock for the whole request, not just the two writes: the
 * outbox is what tells undo a review has not left the device, and that has to
 * stay true from the moment the batch is collected to the moment it is cleared.
 */
export async function pushChanges(): Promise<number> {
  return withSendLock(async () => {
    // Read once: the batch sent and the entries cleared must be the same set.
    const outbox = await db.outbox.toArray()
    if (outbox.length === 0) return 0
    const changes = await collectOutbox(outbox)
    await request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changes),
    })
    await clearSent(outbox)
    await db.sync.put({ ...(await state()), lastPushedAt: Date.now() })
    return outbox.length
  })
}

/**
 * Apply one page of server changes, then bring the derived memories in line
 * with it. Reports how many rows arrived and whether the server has more.
 */
export async function pullChanges(now = Date.now()): Promise<{ rows: number; more: boolean }> {
  const before = await state()
  const response = await request(`${ENDPOINT}?since=${before.cursor}`)
  const payload = (await response.json()) as PullResponse

  // A row with unsent local edits is not overwritten by the server's copy.
  const dirty = new Set((await db.outbox.toArray()).map((e) => e.id))
  const keep = <T extends { id: string }>(table: OutboxTable, rows: T[]) =>
    rows.filter((r) => !dirty.has(outboxKey(table, r.id)))

  const decks = keep('decks', payload.decks)
  const cards = keep('cards', payload.cards)

  await db.transaction('rw', [db.decks, db.cards, db.reviews, db.paramSets, db.sync], async () => {
    if (decks.length) await db.decks.bulkPut(decks)
    if (cards.length) await db.cards.bulkPut(cards)
    // Reviews are immutable, so an incoming copy of one already held is
    // identical by construction and safe to write.
    if (payload.reviews.length) await db.reviews.bulkPut(payload.reviews)
    if (payload.paramSets.length) await db.paramSets.bulkPut(payload.paramSets)
    await db.sync.put({ ...before, cursor: payload.seq, lastPulledAt: Date.now() })
  })

  await rebuildMemoriesFrom(payload.reviews.map((r) => r.sideId))
  await reconcilePulled(decks, cards, now)
  const rows = decks.length + cards.length + payload.reviews.length + payload.paramSets.length
  // `more` is absent from a server that predates it, which never paged past a
  // full table anyway.
  return { rows, more: payload.more === true }
}

/**
 * Memories are derived, so they are never synced — they are recomputed from
 * whatever reviews arrived. Taking the newest review's snapshot rather than
 * replaying is what makes this cheap, and it reproduces exactly what the device
 * that did the reviewing computed, fuzz included (§2).
 */
export async function rebuildMemoriesFrom(sideIds: SideId[]) {
  for (const sideId of new Set(sideIds)) {
    const newest = await newestReview(sideId)
    if (newest) await db.memories.put(newest.memoryAfter)
  }
}

/**
 * Which sides hold a schedule is decided by cards and decks, and those arrive
 * here too: a card made on another device, a tombstone, a field switched to
 * tested. Without this a synced card that was never reviewed had no memory at
 * all — due in the queue, but its grades went nowhere — and a card deleted
 * elsewhere kept counting towards "Review N sides".
 *
 * Runs after `rebuildMemoriesFrom`, so a review for a side that should not be
 * scheduled any more does not bring its memory back.
 */
async function reconcilePulled(decks: Deck[], cards: Card[], now: number) {
  if (decks.length === 0 && cards.length === 0) return
  await db.transaction('rw', [db.decks, db.cards, db.memories, db.reviews], async () => {
    const touched = new Map(cards.map((c) => [c.id, c]))
    for (const deck of decks) {
      for (const card of await db.cards.where('deckId').equals(deck.id).toArray()) {
        touched.set(card.id, card)
      }
    }
    const deckIds = [...new Set([...touched.values()].map((c) => c.deckId))]
    const deckById = new Map(
      (await db.decks.bulkGet(deckIds)).flatMap((d) => (d ? [[d.id, d] as const] : [])),
    )
    for (const card of touched.values()) {
      await reconcileMemories(deckById.get(card.deckId), card, now)
    }
  })
}

export async function syncOnce(): Promise<{ pushed: number; pulled: number; blobs: number }> {
  // Probe before doing anything expensive: an unreachable server should cost a
  // single small request, not a multi-megabyte push that fails slowly.
  if (!(await reachable())) throw new NetworkError('/api/healthz unreachable')

  const pushed = await pushChanges()
  // Page until caught up, so a cold device has the whole corpus after one
  // sync rather than one page per poll.
  let pulled = 0
  for (let more = true; more;) {
    const page = await pullChanges()
    pulled += page.rows
    more = page.more
  }
  // Images go last and in small batches: a review must never queue behind a photo.
  const blobs = (await uploadPending()) + (await downloadMissing())
  return { pushed, pulled, blobs }
}
