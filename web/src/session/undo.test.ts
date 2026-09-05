/**
 * Undo, and the boundary that limits it. See DESIGN.md §5, §6, §9.
 *
 * Reviews are append-only and immutable, which is the single property that
 * makes sync conflict-free. So undo is offered only while a commit is still
 * unsent: unpushed, a review has no standing anywhere else and can simply go;
 * pushed, it is part of the shared log and stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import type { Card, Deck, ReviewSession } from '@eidet/shared'
import { newMemory } from '@eidet/shared'
import { db } from '../db/db.ts'
import { pushChanges } from '../sync/sync.ts'
import { canUndo, commit, undo } from './session.ts'

const T0 = Date.UTC(2026, 0, 1)

const deck: Deck = {
  id: 'd1',
  name: 'Kanji',
  mode: 'schema',
  fields: [
    { id: 'f1', name: 'glyph', kind: 'text', tested: true },
    { id: 'f2', name: 'reading', kind: 'text', tested: true },
  ],
  cuePreference: 'auto',
  order: 0,
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
}

const card: Card = {
  id: 'c1',
  deckId: 'd1',
  sides: [
    { id: 's1', fieldId: 'f1', label: null, kind: 'text', value: '憂', tested: null },
    { id: 's2', fieldId: 'f2', label: null, kind: 'text', value: 'ユウ', tested: null },
  ],
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
}

const session = (): ReviewSession => ({
  id: 'sess',
  deckIds: [],
  queue: [
    { cardId: 'c1', deckId: 'd1', cueSideId: 's1', targetSideIds: ['s2'], contextSideIds: [] },
  ],
  index: 0,
  phase: 'revealed',
  missedSideIds: [],
  startedAt: T0,
  gradedCount: 0,
  lastCommit: null,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.decks.put(deck)
  await db.cards.put(card)
  await db.memories.put(newMemory({ sideId: 's2', cardId: 'c1', deckId: 'd1' }, T0))
  await db.sessions.put(session())
})

describe('undo', () => {
  it('puts the side back exactly as it was and drops the review', async () => {
    const before = (await db.memories.get('s2'))!
    const graded = await commit(session(), 3, T0 + 1000)

    expect(await db.reviews.count()).toBe(1)
    expect((await db.memories.get('s2'))!.reps).toBe(1)
    expect(graded.index).toBe(1)

    expect(await canUndo(graded)).toBe(true)
    const back = await undo(graded, T0)

    expect(await db.reviews.count()).toBe(0)
    // This side had never been reviewed, so `memoryBefore` was null and it goes
    // back to being new — which is exactly the state it started in.
    expect(await db.memories.get('s2')).toEqual(before)
    expect(back.index).toBe(0)
    expect(back.gradedCount).toBe(0)
    // The reveal comes back, so the screen is the one that was graded.
    expect(back.phase).toBe('revealed')
  })

  it('restores the missed toggles along with the reveal', async () => {
    const graded = await commit({ ...session(), missedSideIds: ['s2'] }, 3, T0 + 1000)
    const back = await undo(graded, T0)
    expect(back.missedSideIds).toEqual(['s2'])
  })

  it('restores the previous schedule, not a blank one, on a side with history', async () => {
    const first = await commit(session(), 3, T0 + 1000)
    const settled = (await db.memories.get('s2'))!

    // A second reveal of the same card, graded and then taken back.
    const again = await commit({ ...first, index: 0, phase: 'revealed' }, 1, T0 + 2000)
    expect((await db.memories.get('s2'))!.reps).toBe(2)

    await undo(again, T0 + 2000)
    // Back to the state the first grade left, not to a blank memory — the
    // review row carried the exact snapshot it replaced.
    expect(await db.memories.get('s2')).toEqual(settled)
    expect((await db.memories.get('s2'))!.reps).toBe(1)
    expect(await db.reviews.count()).toBe(1)
  })

  it('leaves the outbox clean, so nothing undone is ever pushed', async () => {
    const graded = await commit(session(), 3, T0 + 1000)
    expect(await db.outbox.where('table').equals('reviews').count()).toBe(1)
    await undo(graded, T0)
    expect(await db.outbox.where('table').equals('reviews').count()).toBe(0)
  })

  it('is refused once the review has been pushed', async () => {
    const graded = await commit(session(), 3, T0 + 1000)
    // What a successful push does: the outbox entry goes, the review stays.
    await db.outbox.clear()

    expect(await canUndo(graded)).toBe(false)
    const same = await undo(graded, T0)
    expect(await db.reviews.count()).toBe(1)
    expect(same.index).toBe(1)
    expect((await db.memories.get('s2'))!.reps).toBe(1)
  })

  it('is not offered before anything has been graded', async () => {
    expect(await canUndo(session())).toBe(false)
  })
})

/**
 * The window that made "unsent" a lie. A push keeps its rows in the outbox for
 * the length of the request, so a naive check sees an entry for a review the
 * server has already taken — and undoing it deletes a row the next pull brings
 * straight back, memory and all. Both sides take the send lock, so the two can
 * only happen in one order or the other.
 */
describe('undo against a push in flight', () => {
  /** A push whose request hangs until the test lets it answer. */
  function hangingPush() {
    let release = () => {}
    const sent = new Promise<void>((r) => (release = r))
    let arrived = () => {}
    const inFlight = new Promise<void>((r) => (arrived = r))

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        arrived()
        await sent
        return new Response('{}', { status: 200 })
      }),
    )
    return { inFlight, release: () => release(), push: () => pushChanges() }
  }

  it('declines, and leaves the review the server accepted alone', async () => {
    const graded = await commit(session(), 3, T0 + 1000)
    const memory = (await db.memories.get('s2'))!

    const { inFlight, release, push } = hangingPush()
    const pushed = push()
    await inFlight

    // Pressed with the request still open: the entry is in the outbox, but the
    // review is already on its way.
    const attempt = undo(graded, T0)
    release()
    await pushed
    const same = await attempt

    expect(await db.reviews.count()).toBe(1)
    expect(await db.memories.get('s2')).toEqual(memory)
    // The screen stays on the card after the graded one, or the next grade
    // would write a second review for the same side.
    expect(same.index).toBe(1)
    expect(same.gradedCount).toBe(graded.gradedCount)
    expect(await canUndo(same)).toBe(false)
  })

  it('takes the review back before the push can collect it', async () => {
    const graded = await commit(session(), 3, T0 + 1000)
    const fetched = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetched)

    // The other order: undo claims the lock, and the push queues behind it.
    const attempt = undo(graded, T0)
    const pushed = pushChanges()
    const back = await attempt
    await pushed

    expect(back.index).toBe(0)
    expect(await db.reviews.count()).toBe(0)
    // The push went ahead — there is a parameter set to send — but it carries
    // no review, because the one it would have sent no longer exists.
    const body = JSON.parse(String(fetched.mock.calls[0]![1]!.body)) as { reviews: unknown[] }
    expect(body.reviews).toEqual([])
  })
})

