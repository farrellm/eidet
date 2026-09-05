/**
 * The sync protocol (DESIGN.md §6). The three data classes have three different
 * conflict rules, and those rules are the whole reason offline editing is safe.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { Card, Deck, Review } from '@eidet/shared'
import { openDb } from '../src/db.ts'
import { pull, push } from '../src/changes.ts'

let db: DatabaseSync
beforeEach(() => {
  db = openDb(':memory:')
})

const deck = (over: Partial<Deck> = {}): Deck => ({
  id: 'd1',
  name: 'Kanji',
  mode: 'schema',
  fields: [{ id: 'f1', name: 'glyph', kind: 'text', tested: true }],
  cuePreference: 'auto',
  order: 0,
  updatedAt: 1000,
  deletedAt: null,
  seq: 0,
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1',
  deckId: 'd1',
  sides: [{ id: 's1', fieldId: 'f1', label: null, kind: 'text', value: '憂', tested: null }],
  updatedAt: 1000,
  deletedAt: null,
  seq: 0,
  ...over,
})

const review = (over: Partial<Review> = {}): Review => ({
  id: 'r1',
  sideId: 's1',
  cardId: 'c1',
  deckId: 'd1',
  cueSideId: 's2',
  rating: 3,
  reviewedAt: 5000,
  memoryBefore: null,
  memoryAfter: { sideId: 's1', cardId: 'c1', deckId: 'd1', due: 9000, stability: 3, difficulty: 5, elapsedDays: 0, scheduledDays: 1, learningSteps: 0, reps: 1, lapses: 0, state: 2, lastReview: 5000 },
  paramsHash: 'abc12345',
  ...over,
})

describe('cursor', () => {
  it('returns only rows newer than the cursor', () => {
    push(db, { decks: [deck()] })
    const first = pull(db, 0)
    expect(first.decks).toHaveLength(1)

    push(db, { cards: [card()] })
    const second = pull(db, first.seq)
    expect(second.decks).toHaveLength(0)
    expect(second.cards).toHaveLength(1)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('advances monotonically across every table', () => {
    const a = push(db, { decks: [deck()] })
    const b = push(db, { cards: [card()] })
    const c = push(db, { reviews: [review()] })
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  it('gives an empty pull at the head', () => {
    push(db, { decks: [deck()] })
    const head = pull(db, 0).seq
    const again = pull(db, head)
    expect(again.decks).toHaveLength(0)
    expect(again.seq).toBe(head)
  })
})

describe('mutable rows: last write wins', () => {
  it('accepts a newer edit', () => {
    push(db, { decks: [deck({ name: 'Kanji' })] })
    push(db, { decks: [deck({ name: 'Kanji II', updatedAt: 2000 })] })
    expect(pull(db, 0).decks[0]!.name).toBe('Kanji II')
  })

  it('drops an edit older than the stored row', () => {
    push(db, { decks: [deck({ name: 'Newer', updatedAt: 5000 })] })
    push(db, { decks: [deck({ name: 'Older', updatedAt: 1000 })] })
    expect(pull(db, 0).decks[0]!.name).toBe('Newer')
  })

  it('carries a deletion as a tombstone rather than removing the row', () => {
    push(db, { cards: [card()] })
    push(db, { cards: [card({ deletedAt: 3000, updatedAt: 3000 })] })
    const pulled = pull(db, 0).cards[0]!
    expect(pulled.deletedAt).toBe(3000)
  })

  it('round-trips JSON columns intact', () => {
    push(db, { decks: [deck()], cards: [card()] })
    const out = pull(db, 0)
    expect(out.decks[0]!.fields).toEqual(deck().fields)
    expect(out.cards[0]!.sides).toEqual(card().sides)
  })
})

describe('reviews are append-only', () => {
  it('cannot conflict — pushing the same review twice is a no-op', () => {
    push(db, { reviews: [review()] })
    push(db, { reviews: [review({ rating: 1 })] })
    const out = pull(db, 0).reviews
    expect(out).toHaveLength(1)
    expect(out[0]!.rating).toBe(3)
  })

  it('unions reviews from two offline clients', () => {
    push(db, { reviews: [review({ id: 'a' }), review({ id: 'b' })] })
    push(db, { reviews: [review({ id: 'b' }), review({ id: 'c' })] })
    expect(pull(db, 0).reviews.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('preserves the memory snapshot that scheduling depends on', () => {
    push(db, { reviews: [review()] })
    expect(pull(db, 0).reviews[0]!.memoryAfter).toEqual(review().memoryAfter)
    expect(pull(db, 0).reviews[0]!.memoryBefore).toBeNull()
  })
})

describe('push is idempotent', () => {
  it('re-sending an unchanged batch leaves the same data', () => {
    const batch = { decks: [deck()], cards: [card()], reviews: [review()] }
    push(db, batch)
    push(db, batch)
    const out = pull(db, 0)
    expect(out.decks).toHaveLength(1)
    expect(out.cards).toHaveLength(1)
    expect(out.reviews).toHaveLength(1)
  })

  it('rolls back the whole batch if one row is malformed', () => {
    const bad = { ...card(), sides: undefined as unknown as Card['sides'] }
    expect(() => push(db, { decks: [deck()], cards: [bad] })).toThrow()
    expect(pull(db, 0).decks).toHaveLength(0)
  })
})

/**
 * A client pages through a backlog by feeding the returned `seq` back in. If
 * that number does not advance, the client re-pulls the same page forever —
 * which is what happened while the high-water mark was read off the mapped
 * objects, because `Review` deliberately carries no `seq` field.
 */
describe('paging', () => {
  const PAGE = 2000

  it('advances the cursor through a review backlog larger than one page', () => {
    const reviews = Array.from({ length: PAGE + 5 }, (_, i) =>
      review({ id: `r${i}`, reviewedAt: 5000 + i }),
    )
    push(db, { reviews })

    const first = pull(db, 0)
    expect(first.reviews).toHaveLength(PAGE)
    expect(first.seq).toBeGreaterThan(0)

    const second = pull(db, first.seq)
    expect(second.reviews).toHaveLength(5)
    expect(second.seq).toBeGreaterThan(first.seq)

    // Every row arrived exactly once across the two pages.
    const ids = [...first.reviews, ...second.reviews].map((r) => r.id)
    expect(new Set(ids).size).toBe(PAGE + 5)

    // And the client has converged: another pull returns nothing new.
    expect(pull(db, second.seq).reviews).toHaveLength(0)
  })

  it('does not skip rows when a table other than decks or cards fills the page', () => {
    // paramSets and blobs page too, and were once absent from the "is this
    // page full?" test — so the cursor jumped to the server's current seq and
    // the remainder was never handed over.
    const sets = Array.from({ length: PAGE + 5 }, (_, i) => ({
      hash: `h${i}`,
      w: [0.1],
      requestRetention: 0.9,
      learningSteps: ['1m', '10m'],
      createdAt: 1000 + i,
    }))
    push(db, { paramSets: sets })

    const first = pull(db, 0)
    expect(first.paramSets).toHaveLength(PAGE)
    const second = pull(db, first.seq)
    expect(second.paramSets).toHaveLength(5)
    expect(pull(db, second.seq).paramSets).toHaveLength(0)
  })

  it('does not strand a capped table under a later row from another one', () => {
    // The realistic shape: a backlog of reviews goes up, then a deck is edited.
    // The deck's row sits above the reviews' page boundary, so a cursor taken
    // as the highest seq on the page skips the reviews that did not fit.
    push(db, {
      reviews: Array.from({ length: PAGE + 5 }, (_, i) =>
        review({ id: `r${i}`, reviewedAt: 5000 + i }),
      ),
    })
    push(db, { decks: [deck()] })

    const first = pull(db, 0)
    expect(first.reviews).toHaveLength(PAGE)
    expect(first.decks).toHaveLength(1)

    const second = pull(db, first.seq)
    const ids = new Set([...first.reviews, ...second.reviews].map((r) => r.id))
    expect(ids.size).toBe(PAGE + 5)
  })
})
