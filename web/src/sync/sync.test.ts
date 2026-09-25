/**
 * The one sync rule that loses work if it breaks, from both sides. See §6.
 *
 * A pull must not clobber a row that still has unsent local edits, and a push
 * must not clear an edit it did not send. Everything else about sync is
 * recoverable — a missed push retries, a stale cursor re-pulls — but losing an
 * edit made offline is silent, and the user finds out days later.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { type Card, type Deck, type PullResponse, grade, newMemory, defaultParamSet } from '@eidet/shared'
import { db, enqueue } from '../db/db.ts'
import { pullChanges, pushChanges, syncOnce } from './sync.ts'

const T0 = Date.UTC(2026, 0, 1)

const deck = (over: Partial<Deck> = {}): Deck => ({
  id: 'd1',
  name: 'Kanji',
  mode: 'schema',
  fields: [],
  cuePreference: 'auto',
  order: 0,
  updatedAt: T0,
  deletedAt: null,
  seq: 1,
  ...over,
})

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c1',
  deckId: 'd1',
  sides: [{ id: 's1', fieldId: 'f1', label: null, kind: 'text', value: 'server', tested: null }],
  updatedAt: T0,
  deletedAt: null,
  seq: 2,
  ...over,
})

function serverSays(payload: Partial<PullResponse>) {
  const body: PullResponse = {
    seq: 9,
    more: false,
    decks: [],
    cards: [],
    reviews: [],
    paramSets: [],
    blobs: [],
    ...payload,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a pull does not clobber unsent local edits', () => {
  it('skips a deck that is still in the outbox and keeps the local copy', async () => {
    await db.decks.put(deck({ name: 'Kanji, renamed offline', updatedAt: T0 + 1000 }))
    await enqueue('decks', 'd1')

    serverSays({ decks: [deck({ name: 'Kanji', updatedAt: T0 })] })
    await pullChanges()

    expect((await db.decks.get('d1'))!.name).toBe('Kanji, renamed offline')
  })

  it('applies a row the outbox knows nothing about', async () => {
    await db.decks.put(deck({ name: 'stale' }))

    serverSays({ decks: [deck({ name: 'from the server', updatedAt: T0 + 5000 })] })
    await pullChanges()

    expect((await db.decks.get('d1'))!.name).toBe('from the server')
  })

  it('protects each row on its own, not the whole table', async () => {
    await db.cards.put(card({ id: 'c1', sides: [] }))
    await enqueue('cards', 'c1')

    serverSays({ cards: [card({ id: 'c1' }), card({ id: 'c2' })] })
    await pullChanges()

    // c1 was dirty and survives untouched; c2 was not and arrives.
    expect((await db.cards.get('c1'))!.sides).toHaveLength(0)
    expect(await db.cards.get('c2')).toBeDefined()
  })

  it('advances the cursor to what the server returned', async () => {
    serverSays({ seq: 42 })
    await pullChanges()
    expect((await db.sync.get('sync'))!.cursor).toBe(42)
  })
})

/**
 * The same rule from the other side: a push clears the outbox, and it must
 * clear only what it actually sent. The outbox is keyed by row, not by edit, so
 * a row edited again during the request is sitting under the very key the push
 * is about to delete.
 */
describe('a push does not clear an edit made during the request', () => {
  it('keeps a row re-queued while the request was open', async () => {
    await db.decks.put(deck())
    await enqueue('decks', 'd1', T0)

    let release = () => {}
    const answered = new Promise<void>((r) => (release = r))
    let arrived = () => {}
    const inFlight = new Promise<void>((r) => (arrived = r))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        arrived()
        await answered
        return new Response('{}', { status: 200 })
      }),
    )

    const pushed = pushChanges()
    await inFlight
    await db.decks.put(deck({ name: 'renamed while the push was open' }))
    await enqueue('decks', 'd1', T0 + 1000)
    release()
    await pushed

    // Still dirty, so the rename goes up on the next push instead of sitting
    // on the device with nothing left to say it is unsent.
    expect(await db.outbox.get('decks:d1')).toBeDefined()
  })

  it('clears a row that was left alone', async () => {
    await db.decks.put(deck())
    await enqueue('decks', 'd1', T0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

    expect(await pushChanges()).toBe(1)
    expect(await db.outbox.get('decks:d1')).toBeUndefined()
  })
})

/**
 * Memories are derived locally, from reviews *and* from which sides the cards
 * and decks say are scheduled. A pull brings both kinds of change.
 */
describe('a pull keeps memories in line with what arrived', () => {
  const tested = deck({ fields: [{ id: 'f1', name: 'glyph', kind: 'text', tested: true }] })

  it('schedules a card made on another device that has never been reviewed', async () => {
    serverSays({ decks: [tested], cards: [card()] })
    await pullChanges(T0)
    // Without a memory the card is in the queue but its grades go nowhere.
    expect(await db.memories.get('s1')).toMatchObject({ cardId: 'c1', deckId: 'd1', reps: 0 })
  })

  it('drops the memories of a card deleted on another device', async () => {
    await db.decks.put(tested)
    await db.cards.put(card())
    await db.memories.put(newMemory({ sideId: 's1', cardId: 'c1', deckId: 'd1' }, T0))

    serverSays({ cards: [card({ deletedAt: T0 + 1, updatedAt: T0 + 1 })] })
    await pullChanges(T0)
    expect(await db.memories.get('s1')).toBeUndefined()
  })

  it('follows a field switched off on another device', async () => {
    await db.decks.put(tested)
    await db.cards.put(card())
    await db.memories.put(newMemory({ sideId: 's1', cardId: 'c1', deckId: 'd1' }, T0))

    serverSays({ decks: [deck({ fields: [{ id: 'f1', name: 'glyph', kind: 'text', tested: false }] })] })
    await pullChanges(T0)
    expect(await db.memories.get('s1')).toBeUndefined()
  })

  it("takes a reviewed side's memory from its newest review", async () => {
    const params = defaultParamSet(T0)
    const first = grade({ reviewId: 'r1', memory: newMemory({ sideId: 's1', cardId: 'c1', deckId: 'd1' }, T0), rating: 3, cueSideId: null, now: T0, params })
    const second = grade({ reviewId: 'r2', memory: first.memory, rating: 3, cueSideId: null, now: T0 + 60_000, params })

    serverSays({ decks: [tested], cards: [card()], reviews: [second.review, first.review] })
    await pullChanges(T0)
    expect(await db.memories.get('s1')).toEqual(second.memory)
  })
})

describe('a sync pages until it has caught up', () => {
  it('keeps pulling while the server says there is more', async () => {
    const pages: Partial<PullResponse>[] = [
      { seq: 5, more: true, decks: [deck({ id: 'd1' })] },
      { seq: 9, more: false, decks: [deck({ id: 'd2' })] },
    ]
    const fetched = vi.fn(async (input: string) => {
      if (input.startsWith('/api/healthz')) return new Response('{}', { status: 200 })
      const body = { seq: 0, more: false, decks: [], cards: [], reviews: [], paramSets: [], blobs: [], ...pages.shift() }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetched)

    await syncOnce()
    expect(await db.decks.count()).toBe(2)
    expect((await db.sync.get('sync'))!.cursor).toBe(9)
    expect(fetched.mock.calls.map(([url]) => url)).toContain('/api/changes?since=5')
  })
})
