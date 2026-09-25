/**
 * Hot paths of the pure model: building a session queue and reading
 * retrievability across a whole collection (the home screen's hero does the
 * latter on every render). `make bench`; compare with `--compare`.
 */
import { bench, describe } from 'vitest'
import type { Card, CardBatch, Deck, Memory, SideId } from '../src/types.ts'
import { buildQueue, interleave } from '../src/queue.ts'
import { retrievability } from '../src/schedule.ts'
import { DAY, T0, card, deck, memory, side } from './factory.ts'

const DECKS = 5
const CARDS = 2000

const decks: Deck[] = Array.from({ length: DECKS }, (_, d) => deck({ id: `d${d}` }))
const cards: Card[] = Array.from({ length: CARDS }, (_, i) =>
  card(
    `c${i}`,
    [side(`c${i}-glyph`, 'f-glyph'), side(`c${i}-read`, 'f-read'), side(`c${i}-mean`, 'f-mean')],
    `d${i % DECKS}`,
  ),
)

// A spread of states: some overdue, some fresh, some never seen.
const memories = new Map<SideId, Memory>()
for (const [i, c] of cards.entries()) {
  for (const [j, s] of c.sides.entries()) {
    if ((i + j) % 7 === 0) continue
    const lag = ((i * 3 + j * 5) % 40) - 20
    memories.set(
      s.id,
      memory(
        s.id,
        c.id,
        { stability: 1 + ((i + j) % 50), lastReview: T0 - 10 * DAY, due: T0 + lag * DAY },
        c.deckId,
      ),
    )
  }
}
const list = [...memories.values()]

const batches: CardBatch[] = buildQueue({ decks, cards, memories, now: T0 })

describe('queue', () => {
  bench('buildQueue, 2000 cards', () => {
    buildQueue({ decks, cards, memories, now: T0 })
  })
  bench('interleave', () => {
    interleave(batches, memories, T0)
  })
})

describe('retrievability', () => {
  bench(`over ${list.length} memories`, () => {
    for (const m of list) retrievability(m, T0)
  })
})
