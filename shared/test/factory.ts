/** Builders for the scheduling tests. Everything is explicit — no hidden clock. */
import {
  type Card,
  type Deck,
  type DeckField,
  type Memory,
  type Side,
  type SideId,
} from '../src/types.ts'
import { newMemory } from '../src/schedule.ts'

export const T0 = Date.parse('2026-01-01T09:00:00Z')
export const DAY = 86_400_000

export function field(id: string, name: string, tested = true): DeckField {
  return { id, name, kind: 'text', tested }
}

export function deck(over: Partial<Deck> = {}): Deck {
  return {
    id: 'deck-kanji',
    name: 'Kanji',
    mode: 'schema',
    fields: [field('f-glyph', 'glyph'), field('f-read', 'reading'), field('f-mean', 'meaning')],
    cuePreference: 'auto',
    order: 0,
    updatedAt: T0,
    deletedAt: null,
    seq: 0,
    ...over,
  }
}

export function side(id: string, fieldId: string, value = 'x'): Side {
  return { id, fieldId, label: null, kind: 'text', value, tested: null }
}

export function card(id: string, sides: Side[], deckId = 'deck-kanji'): Card {
  return { id, deckId, sides, updatedAt: T0, deletedAt: null, seq: 0 }
}

/** A three-sided card whose sides are `<id>-glyph`, `-read`, `-mean`. */
export function kanji(id: string): Card {
  return card(id, [
    side(`${id}-glyph`, 'f-glyph', '憂'),
    side(`${id}-read`, 'f-read', 'ユウ'),
    side(`${id}-mean`, 'f-mean', 'grief'),
  ])
}

/** A memory with an explicit due date and stability, bypassing FSRS. */
export function memory(
  sideId: SideId,
  cardId: string,
  over: Partial<Memory> = {},
  deckId = 'deck-kanji',
): Memory {
  return {
    ...newMemory({ sideId, cardId, deckId }, T0),
    stability: 10,
    difficulty: 5,
    reps: 1,
    state: 2,
    lastReview: T0 - DAY,
    due: T0 + DAY,
    ...over,
  }
}

export function memories(...list: Memory[]): Map<SideId, Memory> {
  return new Map(list.map((m) => [m.sideId, m]))
}
