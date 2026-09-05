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
import type { Card, ChangeSet, Deck, ParamSet, PullResponse, Review } from '@eidet/shared'
import { currentSeq, nextSeq } from './db.ts'

/** How many rows one pull may return, so a cold sync pages rather than stalls. */
const PAGE = 2000

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
  const rows = <T>(sql: string): T[] => {
    const page = db.prepare(sql).all(since, PAGE) as (T & { seq: number })[]
    // Ordered by seq, so the last row is this table's high-water mark.
    if (page.length === PAGE) cap = Math.min(cap, page[page.length - 1]!.seq)
    return page
  }

  const decks = rows<Record<string, unknown>>(
    'SELECT * FROM decks WHERE seq > ? ORDER BY seq LIMIT ?',
  ).map(
    (r): Deck => ({
      id: r.id as string,
      name: r.name as string,
      mode: r.mode as Deck['mode'],
      fields: JSON.parse(r.fields as string),
      cuePreference: r.cuePreference as Deck['cuePreference'],
      order: r.order as number,
      updatedAt: r.updatedAt as number,
      deletedAt: (r.deletedAt as number | null) ?? null,
      seq: r.seq as number,
    }),
  )

  const cards = rows<Record<string, unknown>>(
    'SELECT * FROM cards WHERE seq > ? ORDER BY seq LIMIT ?',
  ).map(
    (r): Card => ({
      id: r.id as string,
      deckId: r.deckId as string,
      sides: JSON.parse(r.sides as string),
      updatedAt: r.updatedAt as number,
      deletedAt: (r.deletedAt as number | null) ?? null,
      seq: r.seq as number,
    }),
  )

  const reviews = rows<Record<string, unknown>>(
    'SELECT * FROM reviews WHERE seq > ? ORDER BY seq LIMIT ?',
  ).map(
    (r): Review => ({
      id: r.id as string,
      sideId: r.sideId as string,
      cardId: r.cardId as string,
      deckId: r.deckId as string,
      cueSideId: (r.cueSideId as string | null) ?? null,
      rating: r.rating as Review['rating'],
      reviewedAt: r.reviewedAt as number,
      memoryBefore: r.memoryBefore ? JSON.parse(r.memoryBefore as string) : null,
      memoryAfter: JSON.parse(r.memoryAfter as string),
      paramsHash: r.paramsHash as string,
    }),
  )

  const paramSets = rows<Record<string, unknown>>(
    'SELECT * FROM paramSets WHERE seq > ? ORDER BY seq LIMIT ?',
  ).map(
    (r): ParamSet => ({
      hash: r.hash as string,
      w: JSON.parse(r.w as string),
      requestRetention: r.requestRetention as number,
      learningSteps: JSON.parse(r.learningSteps as string),
      createdAt: r.createdAt as number,
    }),
  )

  const blobs = rows<Record<string, unknown>>(
    'SELECT * FROM blobs WHERE seq > ? ORDER BY seq LIMIT ?',
  ).map((r) => ({
    sha256: r.sha256 as string,
    mime: r.mime as string,
    bytes: r.bytes as number,
    width: r.width as number,
    height: r.height as number,
    createdAt: r.createdAt as number,
  }))

  // A full page from any table means there is more behind it, so the client
  // resumes from what it was actually given rather than from the server's
  // current sequence, which would skip the remainder.
  const seq = Number.isFinite(cap) ? cap : currentSeq(db)
  return { seq, decks, cards, reviews, paramSets, blobs }
}

export function push(db: DatabaseSync, changes: Partial<ChangeSet>): number {
  db.exec('BEGIN')
  try {
    for (const deck of changes.decks ?? []) upsertDeck(db, deck)
    for (const card of changes.cards ?? []) upsertCard(db, card)
    for (const review of changes.reviews ?? []) insertReview(db, review)
    for (const set of changes.paramSets ?? []) insertParamSet(db, set)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return currentSeq(db)
}

/** Last write wins: an incoming row older than the stored one is dropped. */
function upsertDeck(db: DatabaseSync, deck: Deck) {
  const existing = db.prepare('SELECT updatedAt FROM decks WHERE id = ?').get(deck.id) as
    | { updatedAt: number }
    | undefined
  if (existing && existing.updatedAt > deck.updatedAt) return
  db.prepare(
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
  const existing = db.prepare('SELECT updatedAt FROM cards WHERE id = ?').get(card.id) as
    | { updatedAt: number }
    | undefined
  if (existing && existing.updatedAt > card.updatedAt) return
  db.prepare(
    `INSERT INTO cards (id, deckId, sides, updatedAt, deletedAt, seq)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       deckId = excluded.deckId, sides = excluded.sides,
       updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt, seq = excluded.seq`,
  ).run(
    card.id,
    card.deckId,
    JSON.stringify(card.sides),
    card.updatedAt,
    card.deletedAt,
    nextSeq(db),
  )
}

/** Immutable: re-sending a review is a no-op, which makes push idempotent. */
function insertReview(db: DatabaseSync, review: Review) {
  db.prepare(
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

function insertParamSet(db: DatabaseSync, set: ParamSet) {
  db.prepare(
    `INSERT INTO paramSets (hash, w, requestRetention, learningSteps, createdAt, seq)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
  ).run(
    set.hash,
    JSON.stringify(set.w),
    set.requestRetention,
    // A client that predates the field sends nothing for it; it ran on the
    // FSRS defaults, so that is what gets recorded.
    JSON.stringify(set.learningSteps ?? ['1m', '10m']),
    set.createdAt,
    nextSeq(db),
  )
}
