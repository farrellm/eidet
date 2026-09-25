/**
 * The sync protocol. See DESIGN.md §6.
 *
 * Two calls and one number. `pull(since)` returns everything stamped after that
 * sequence; `push(changes)` accepts a batch and stamps it. Three data classes,
 * three rules:
 *
 *   reviews   append-only  — union by id; a review is never updated, so this
 *                            class cannot conflict at all
 *   decks     mutable      — last write wins on `updatedAt`, tombstoned
 *   cards                    via `deletedAt`
 *   paramSets immutable    — keyed by content hash; first write wins
 *
 * Last-write-wins is honest for one user with one primary device. The accepted
 * caveat is that editing the same card on two devices while both are offline
 * loses one edit. Reviews never lose.
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  BlobMeta,
  Card,
  ChangeSet,
  Deck,
  ParamSet,
  PullResponse,
  Review,
} from '@eidet/shared'
import { currentSeq, nextSeq, stmt, transaction } from './db.ts'

/** How many rows one pull may return, so a cold sync pages rather than stalls. */
const PAGE = 2000

// ------------------------------------------------------------- stored rows
//
// The columns as SQLite hands them back: JSON columns are text, and every row
// carries the `seq` it was stamped with.

interface Stamped {
  seq: number
}

interface DeckRow extends Stamped {
  id: string
  name: string
  mode: Deck['mode']
  fields: string
  cuePreference: Deck['cuePreference']
  order: number
  updatedAt: number
  deletedAt: number | null
}

interface CardRow extends Stamped {
  id: string
  deckId: string
  sides: string
  updatedAt: number
  deletedAt: number | null
}

interface ReviewRow extends Stamped {
  id: string
  sideId: string
  cardId: string
  deckId: string
  cueSideId: string | null
  rating: Review['rating']
  reviewedAt: number
  memoryBefore: string | null
  memoryAfter: string
  paramsHash: string
}

interface ParamSetRow extends Stamped {
  hash: string
  w: string
  requestRetention: number
  learningSteps: string
  createdAt: number
}

interface BlobRow extends Stamped, BlobMeta {}

const toDeck = (r: DeckRow): Deck => ({
  id: r.id,
  name: r.name,
  mode: r.mode,
  fields: JSON.parse(r.fields),
  cuePreference: r.cuePreference,
  order: r.order,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt ?? null,
  seq: r.seq,
})

const toCard = (r: CardRow): Card => ({
  id: r.id,
  deckId: r.deckId,
  sides: JSON.parse(r.sides),
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt ?? null,
  seq: r.seq,
})

const toReview = (r: ReviewRow): Review => ({
  id: r.id,
  sideId: r.sideId,
  cardId: r.cardId,
  deckId: r.deckId,
  cueSideId: r.cueSideId ?? null,
  rating: r.rating,
  reviewedAt: r.reviewedAt,
  memoryBefore: r.memoryBefore ? JSON.parse(r.memoryBefore) : null,
  memoryAfter: JSON.parse(r.memoryAfter),
  paramsHash: r.paramsHash,
})

const toParamSet = (r: ParamSetRow): ParamSet => ({
  hash: r.hash,
  w: JSON.parse(r.w),
  requestRetention: r.requestRetention,
  learningSteps: JSON.parse(r.learningSteps),
  createdAt: r.createdAt,
})

const toBlobMeta = (r: BlobRow): BlobMeta => ({
  sha256: r.sha256,
  mime: r.mime,
  bytes: r.bytes,
  width: r.width,
  height: r.height,
  createdAt: r.createdAt,
})

// -------------------------------------------------------------------- pull

export function pull(db: DatabaseSync, since: number): PullResponse {
  /*
   * Every table pages independently, so the cursor handed back has to be a
   * sequence past which *no* table still owes rows. Read it off the raw rows:
   * `seq` is a storage column and most of the shared types deliberately do not
   * carry it, so deriving the mark from the mapped objects silently scored
   * reviews and paramSets as 0 and pinned the cursor at `since` — a client with
   * a review backlog re-pulled the same page forever.
   *
   * The mark is the *lowest* last-seq among the tables that filled their page,
   * not the highest seq seen anywhere. Pushing a backlog of reviews and then
   * editing a deck puts the deck's row above the reviews' page boundary, and
   * taking the maximum would hand back a cursor past the reviews this page
   * could not fit — stranding them for good. A table that did not fill its page
   * may be re-sent a row or two; every write here is idempotent, so that costs
   * nothing, while a skipped row is never seen again.
   */
  let cap = Number.POSITIVE_INFINITY
  const page = <Row extends Stamped>(table: string): Row[] => {
    const rows = stmt(db, `SELECT * FROM ${table} WHERE seq > ? ORDER BY seq LIMIT ?`).all(
      since,
      PAGE,
    ) as unknown as Row[]
    // Ordered by seq, so the last row is this table's high-water mark.
    if (rows.length === PAGE) cap = Math.min(cap, rows.at(-1)!.seq)
    return rows
  }

  const decks = page<DeckRow>('decks').map(toDeck)
  const cards = page<CardRow>('cards').map(toCard)
  const reviews = page<ReviewRow>('reviews').map(toReview)
  const paramSets = page<ParamSetRow>('paramSets').map(toParamSet)
  const blobs = page<BlobRow>('blobs').map(toBlobMeta)

  // A full page from any table means there is more behind it, so the client
  // resumes from what it was actually given rather than from the server's
  // current sequence, which would skip the remainder.
  const seq = Number.isFinite(cap) ? cap : currentSeq(db)
  return { seq, decks, cards, reviews, paramSets, blobs }
}

// -------------------------------------------------------------------- push

export function push(db: DatabaseSync, changes: Partial<ChangeSet>): number {
  transaction(db, () => {
    for (const deck of changes.decks ?? []) upsertDeck(db, deck)
    for (const card of changes.cards ?? []) upsertCard(db, card)
    for (const review of changes.reviews ?? []) insertReview(db, review)
    for (const set of changes.paramSets ?? []) insertParamSet(db, set)
  })
  return currentSeq(db)
}

/** Last write wins: is the stored copy of this row newer than the incoming one? */
function storedIsNewer(db: DatabaseSync, table: 'decks' | 'cards', id: string, updatedAt: number) {
  const existing = stmt(db, `SELECT updatedAt FROM ${table} WHERE id = ?`).get(id) as
    | { updatedAt: number }
    | undefined
  return existing !== undefined && existing.updatedAt > updatedAt
}

function upsertDeck(db: DatabaseSync, deck: Deck) {
  if (storedIsNewer(db, 'decks', deck.id, deck.updatedAt)) return
  stmt(
    db,
    `INSERT INTO decks (id, name, mode, fields, cuePreference, "order", updatedAt, deletedAt, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, mode = excluded.mode, fields = excluded.fields,
       cuePreference = excluded.cuePreference, "order" = excluded."order",
       updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, seq = excluded.seq`,
  ).run(
    deck.id,
    deck.name,
    deck.mode,
    JSON.stringify(deck.fields),
    deck.cuePreference,
    deck.order,
    deck.updatedAt,
    deck.deletedAt,
    nextSeq(db),
  )
}

function upsertCard(db: DatabaseSync, card: Card) {
  if (storedIsNewer(db, 'cards', card.id, card.updatedAt)) return
  stmt(
    db,
    `INSERT INTO cards (id, deckId, sides, updatedAt, deletedAt, seq)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       deckId = excluded.deckId, sides = excluded.sides,
       updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, seq = excluded.seq`,
  ).run(card.id, card.deckId, JSON.stringify(card.sides), card.updatedAt, card.deletedAt, nextSeq(db))
}

/** Immutable: re-sending a review is a no-op, which makes push idempotent. */
function insertReview(db: DatabaseSync, review: Review) {
  stmt(
    db,
    `INSERT INTO reviews
       (id, sideId, cardId, deckId, cueSideId, rating, reviewedAt, memoryBefore, memoryAfter, paramsHash, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    review.id,
    review.sideId,
    review.cardId,
    review.deckId,
    review.cueSideId,
    review.rating,
    review.reviewedAt,
    review.memoryBefore ? JSON.stringify(review.memoryBefore) : null,
    JSON.stringify(review.memoryAfter),
    review.paramsHash,
    nextSeq(db),
  )
}

/** Immutable and keyed by content hash: the first write wins. */
function insertParamSet(db: DatabaseSync, set: ParamSet) {
  stmt(
    db,
    `INSERT INTO paramSets (hash, w, requestRetention, learningSteps, createdAt, seq)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
  ).run(
    set.hash,
    JSON.stringify(set.w),
    set.requestRetention,
    // A client that predates the field sends nothing for it; it ran on the
    // FSRS defaults, so that is what gets recorded. Spelled out rather than
    // imported: the server takes only types from `@eidet/shared`, never the
    // scheduler behind them.
    JSON.stringify((set.learningSteps as string[] | undefined) ?? ['1m', '10m']),
    set.createdAt,
    nextSeq(db),
  )
}
