/**
 * The device's source of truth. See DESIGN.md §6.
 *
 * IndexedDB holds the whole corpus, not a cache of server responses: reviewing
 * offline needs every card, every memory and every image resident locally, and
 * the scheduler runs here. The network is never on the critical path of a
 * review — sync reconciles this store with the server afterwards.
 */
import Dexie, { type EntityTable } from 'dexie'
import type {
  BlobMeta,
  Card,
  Deck,
  Memory,
  ParamSet,
  Review,
  ReviewSession,
} from '@eidet/shared'

/** Local-only bookkeeping for the sync engine (§6). */
export interface SyncState {
  key: 'sync'
  /** Server sequence high-water mark. */
  cursor: number
  lastPulledAt: number | null
  lastPushedAt: number | null
}

/** Rows edited locally and not yet accepted by the server. */
export interface Outbox {
  /** `${table}:${rowId}` — the outbox is a set of dirty rows, not a log of edits. */
  id: string
  table: 'decks' | 'cards' | 'reviews' | 'paramSets'
  rowId: string
  queuedAt: number
}

/**
 * An image blob held locally; uploaded on its own queue so it never blocks a
 * review. `uploaded` is 0/1 rather than a boolean because IndexedDB cannot
 * index booleans, and this is the field the upload queue scans.
 */
export interface LocalBlob extends BlobMeta {
  data: Blob
  uploaded: 0 | 1
}

/** Small bits of interface state that must survive a reload (§6). */
export interface UiState {
  key: string
  value: unknown
}

export class EidetDb extends Dexie {
  decks!: EntityTable<Deck, 'id'>
  cards!: EntityTable<Card, 'id'>
  memories!: EntityTable<Memory, 'sideId'>
  reviews!: EntityTable<Review, 'id'>
  paramSets!: EntityTable<ParamSet, 'hash'>
  blobs!: EntityTable<LocalBlob, 'sha256'>
  sessions!: EntityTable<ReviewSession, 'id'>
  outbox!: EntityTable<Outbox, 'id'>
  sync!: EntityTable<SyncState, 'key'>
  ui!: EntityTable<UiState, 'key'>

  constructor(name = 'eidet') {
    super(name)
    this.version(1).stores({
      decks: 'id, order, updatedAt',
      cards: 'id, deckId, updatedAt',
      // `due` is indexed because the due queue is one range scan on it.
      memories: 'sideId, cardId, deckId, due, [deckId+due]',
      reviews: 'id, sideId, reviewedAt, [sideId+reviewedAt]',
      paramSets: 'hash',
      blobs: 'sha256, uploaded',
      sessions: 'id, startedAt',
      outbox: 'id, table, rowId, queuedAt',
      sync: 'key',
      ui: 'key',
    })
  }
}

export const db = new EidetDb()

/**
 * Fires when something is queued for the server, so the sync loop can push it
 * promptly instead of waiting out its poll interval. Local-first must not mean
 * a visible lag before work leaves the device when the server is right there.
 */
const dirtyListeners = new Set<() => void>()

export function onDirty(listener: () => void): () => void {
  dirtyListeners.add(listener)
  return () => dirtyListeners.delete(listener)
}

/** Mark a row as needing a push. Idempotent — the outbox is a set, not a log. */
export async function enqueue(table: Outbox['table'], rowId: string, now = Date.now()) {
  await db.outbox.put({ id: `${table}:${rowId}`, table, rowId, queuedAt: now })
  for (const listener of dirtyListeners) listener()
}
