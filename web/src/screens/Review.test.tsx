/**
 * The review screen against a real (fake) IndexedDB. A grade is an await on
 * the database, and a thumb can land twice inside it: that must still be one
 * grade, not two sets of reviews for the same reveal.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { Card, Deck, ReviewSession } from '@eidet/shared'
import { newMemory } from '@eidet/shared'
import { db } from '../db/db.ts'
import { Review } from './Review.tsx'

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

const card = (id: string): Card => ({
  id,
  deckId: 'd1',
  sides: [
    { id: `${id}-s1`, fieldId: 'f1', label: null, kind: 'text', value: `${id} glyph`, tested: null },
    { id: `${id}-s2`, fieldId: 'f2', label: null, kind: 'text', value: `${id} reading`, tested: null },
  ],
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
})

const session: ReviewSession = {
  id: 'sess',
  deckIds: [],
  queue: ['c1', 'c2'].map((id) => ({
    cardId: id,
    deckId: 'd1',
    cueSideId: `${id}-s1`,
    targetSideIds: [`${id}-s2`],
    contextSideIds: [],
  })),
  index: 0,
  phase: 'revealed',
  missedSideIds: [],
  startedAt: T0,
  gradedCount: 0,
  lastCommit: null,
}

beforeEach(async () => {
  await db.delete()
  await db.open()
  await db.decks.put(deck)
  await db.cards.bulkPut([card('c1'), card('c2')])
  await db.memories.bulkPut(
    ['c1', 'c2'].map((c) => newMemory({ sideId: `${c}-s2`, cardId: c, deckId: 'd1' }, T0)),
  )
  await db.sessions.put(session)
})

describe('grading', () => {
  it('counts a double-tapped grade once', async () => {
    render(
      <MemoryRouter initialEntries={['/review/sess']}>
        <Routes>
          <Route path="/review/:sessionId" element={<Review />} />
        </Routes>
      </MemoryRouter>,
    )
    const good = await screen.findByRole('button', { name: 'Good' })
    fireEvent.click(good)
    fireEvent.click(good)

    // The screen moves on to the second card, still in its cue phase.
    await screen.findByRole('button', { name: 'Reveal' })
    await waitFor(async () => expect((await db.sessions.get('sess'))!.index).toBe(1))
    expect(await db.reviews.count()).toBe(1)
  })
})
