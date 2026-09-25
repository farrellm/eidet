/** The sync protocol's two calls under a realistic backlog. `make bench`. */
import { bench, describe } from 'vitest'
import type { Review } from '@eidet/shared'
import { openDb } from '../src/db.ts'
import { pull, push } from '../src/changes.ts'

const review = (i: number): Review => ({
  id: `r${i}`,
  sideId: `s${i % 300}`,
  cardId: `c${i % 100}`,
  deckId: 'd1',
  cueSideId: 's-cue',
  rating: 3,
  reviewedAt: 5000 + i,
  memoryBefore: null,
  memoryAfter: {
    sideId: `s${i % 300}`,
    cardId: `c${i % 100}`,
    deckId: 'd1',
    due: 9000,
    stability: 3,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    lastReview: 5000,
  },
  paramsHash: 'abc12345',
})

const reviews = Array.from({ length: 2000 }, (_, i) => review(i))

const full = openDb(':memory:')
push(full, { reviews })

describe('changes', () => {
  bench('push 2000 reviews', () => {
    push(openDb(':memory:'), { reviews })
  })
  bench('pull a full page', () => {
    pull(full, 0)
  })
})
