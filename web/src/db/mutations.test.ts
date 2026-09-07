/**
 * Deleting a deck. See DESIGN.md §5.
 *
 * A tombstoned deck has to take its cards' memories with it. The queue already
 * skips a card whose deck is gone, but the home screen counts memories — so
 * leaving them behind made "Review N sides" promise more than the session
 * would ask, which reads as a scheduling bug and isn't one.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import type { Card, Deck } from '@eidet/shared'
import { db } from './db.ts'
import { deleteDeck } from './mutations.ts'
import { newMemory } from '@eidet/shared'

const T0 = Date.UTC(2026, 0, 1)

const deck: Deck = {
  id: 'd1',
  name: 'Kanji',
  mode: 'schema',
  fields: [{ id: 'f1', name: 'glyph', kind: 'text', tested: true }],
  cuePreference: 'auto',
  order: 0,
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
}

const card = (id: string, deckId = 'd1'): Card => ({
  id,
  deckId,
  sides: [{ id: `${id}-s1`, fieldId: 'f1', label: null, kind: 'text', value: '憂', tested: null }],
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
})

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.decks.bulkPut([deck, { ...deck, id: 'd2', name: 'Birds' }])
  await db.cards.bulkPut([card('c1'), card('c2'), card('c3', 'd2')])
  await db.memories.bulkPut(
    ['c1', 'c2', 'c3'].map((c) =>
      newMemory({ sideId: `${c}-s1`, cardId: c, deckId: c === 'c3' ? 'd2' : 'd1' }, T0),
    ),
  )
})

describe('deleteDeck', () => {
  it('tombstones the deck and its cards, and drops their memories', async () => {
    await deleteDeck('d1', T0 + 1000)

    expect((await db.decks.get('d1'))!.deletedAt).toBe(T0 + 1000)
    expect((await db.cards.get('c1'))!.deletedAt).toBe(T0 + 1000)
    expect((await db.cards.get('c2'))!.deletedAt).toBe(T0 + 1000)
    expect(await db.memories.get('c1-s1')).toBeUndefined()
    expect(await db.memories.get('c2-s1')).toBeUndefined()
  })

  it('leaves every other deck alone', async () => {
    await deleteDeck('d1', T0 + 1000)

    expect((await db.decks.get('d2'))!.deletedAt).toBeNull()
    expect((await db.cards.get('c3'))!.deletedAt).toBeNull()
    expect(await db.memories.get('c3-s1')).toBeDefined()
  })

  it('queues the deck and every card it took with it', async () => {
    await deleteDeck('d1', T0 + 1000)
    const queued = (await db.outbox.toArray()).map((e) => e.id).sort()
    expect(queued).toContain('decks:d1')
    expect(queued).toContain('cards:c1')
    expect(queued).toContain('cards:c2')
    expect(queued).not.toContain('cards:c3')
  })
})
