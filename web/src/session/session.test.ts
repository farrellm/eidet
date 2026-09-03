/**
 * The grade fan-out (DESIGN.md §1 step 5) — the interaction the whole review
 * screen is built around. Pure, so it is tested without a database.
 */
import { describe, expect, it } from 'vitest'
import type { CardBatch } from '@eidet/shared'
import { plannedGrades } from './session.ts'

const batch: CardBatch = {
  cardId: 'c1',
  deckId: 'd1',
  cueSideId: 'cue',
  targetSideIds: ['a', 'b', 'c'],
  contextSideIds: ['note'],
}

describe('plannedGrades', () => {
  it('applies one press to every target when nothing is missed', () => {
    expect(plannedGrades(batch, [], 3)).toEqual([
      { sideId: 'a', rating: 3 },
      { sideId: 'b', rating: 3 },
      { sideId: 'c', rating: 3 },
    ])
  })

  it('gives missed targets Again and the rest the pressed grade', () => {
    expect(plannedGrades(batch, ['b'], 4)).toEqual([
      { sideId: 'a', rating: 4 },
      { sideId: 'b', rating: 1 },
      { sideId: 'c', rating: 4 },
    ])
  })

  it('grades every target Again when Again is pressed', () => {
    expect(plannedGrades(batch, ['a'], 1).map((g) => g.rating)).toEqual([1, 1, 1])
  })

  it('never grades a context side that was not tapped', () => {
    expect(plannedGrades(batch, [], 3).map((g) => g.sideId)).not.toContain('note')
  })

  it('records Again for a context side the user tapped as missed', () => {
    // A side that was not due carries no information when passed, but a miss on
    // it is real and pulls it back into rotation.
    expect(plannedGrades(batch, ['note'], 4)).toContainEqual({ sideId: 'note', rating: 1 })
  })

  it('never grades the cue', () => {
    expect(plannedGrades(batch, ['cue'], 3).map((g) => g.sideId)).not.toContain('cue')
  })
})
