import { describe, expect, it } from 'vitest'
import { buildBatch, buildQueue, interleave, queueSize, selectCue } from '../src/queue.ts'
import { retrievability } from '../src/schedule.ts'
import { DAY, T0, card, deck, kanji, memories, memory, side } from './factory.ts'

describe('cue selection', () => {
  it('cues with the best-known side that is not being asked', () => {
    const d = deck()
    const c = kanji('k1')
    // reading is due; glyph is fresher than meaning, so glyph should cue.
    const mem = memories(
      memory('k1-glyph', 'k1', { stability: 200, lastReview: T0 - DAY, due: T0 + 100 * DAY }),
      memory('k1-read', 'k1', { due: T0 - DAY }),
      memory('k1-mean', 'k1', { stability: 3, lastReview: T0 - 2 * DAY, due: T0 + DAY }),
    )
    const batch = buildBatch(d, c, mem, T0)!
    expect(batch.cueSideId).toBe('k1-glyph')
    expect(batch.targetSideIds).toEqual(['k1-read'])
    expect(batch.contextSideIds).toEqual(['k1-mean'])
  })

  it('honours a deck that pins its cue field', () => {
    const d = deck({ cuePreference: 'f-glyph' })
    const mem = memories(
      // meaning is by far the best known, but the deck pins glyph as the prompt.
      memory('k1-glyph', 'k1', { stability: 1, lastReview: T0 - 30 * DAY, due: T0 + DAY }),
      memory('k1-read', 'k1', { due: T0 - DAY }),
      memory('k1-mean', 'k1', { stability: 500, lastReview: T0, due: T0 + 300 * DAY }),
    )
    expect(buildBatch(d, kanji('k1'), mem, T0)!.cueSideId).toBe('k1-glyph')
  })

  it('lifts the best-known side out to cue when every side is due', () => {
    const d = deck()
    const mem = memories(
      memory('k1-glyph', 'k1', { stability: 200, lastReview: T0 - DAY, due: T0 - DAY }),
      memory('k1-read', 'k1', { stability: 2, lastReview: T0 - 10 * DAY, due: T0 - DAY }),
      memory('k1-mean', 'k1', { stability: 3, lastReview: T0 - 10 * DAY, due: T0 - DAY }),
    )
    const batch = buildBatch(d, kanji('k1'), mem, T0)!
    expect(batch.cueSideId).toBe('k1-glyph')
    // The lifted side is asked by nothing this session and stays due.
    expect(batch.targetSideIds).toEqual(['k1-read', 'k1-mean'])
    expect(batch.contextSideIds).toEqual([])
  })

  it('never asks a side it just used as the cue', () => {
    const d = deck()
    const mem = memories(
      memory('k1-glyph', 'k1', { due: T0 - DAY }),
      memory('k1-read', 'k1', { due: T0 - DAY }),
      memory('k1-mean', 'k1', { due: T0 - DAY }),
    )
    const batch = buildBatch(d, kanji('k1'), mem, T0)!
    expect(batch.targetSideIds).not.toContain(batch.cueSideId)
    expect(batch.contextSideIds).not.toContain(batch.cueSideId)
  })

  it('prefers a tested side over an untested one as the prompt', () => {
    const d = deck({
      fields: [
        { id: 'f-word', name: 'word', kind: 'text', tested: true },
        { id: 'f-gloss', name: 'gloss', kind: 'text', tested: true },
        { id: 'f-note', name: 'note', kind: 'text', tested: false },
      ],
    })
    const c = card('v1', [
      side('v1-word', 'f-word', 'bruit'),
      side('v1-gloss', 'f-gloss', 'noise'),
      side('v1-note', 'f-note', 'from Old French'),
    ])
    const mem = memories(
      memory('v1-word', 'v1', { due: T0 + DAY }),
      memory('v1-gloss', 'v1', { due: T0 - DAY }),
    )
    const batch = buildBatch(d, c, mem, T0)!
    expect(batch.cueSideId).toBe('v1-word')
    expect(batch.targetSideIds).toEqual(['v1-gloss'])
    // The untested note is revealed as context but never scheduled.
    expect(batch.contextSideIds).toEqual(['v1-note'])
  })

  it('returns null when a card cannot be prompted', () => {
    const d = deck()
    const lone = card('k9', [side('k9-glyph', 'f-glyph', '憂')])
    expect(buildBatch(d, lone, memories(), T0)).toBeNull()
    expect(selectCue(d, [], [], memories(), T0)).toBeNull()
  })
})

describe('due selection and batching', () => {
  it('treats a never-reviewed side as due', () => {
    const batch = buildBatch(deck(), kanji('k1'), memories(), T0)!
    expect(batch.targetSideIds.length).toBe(2)
  })

  it('puts every due side of a card in one reveal', () => {
    const mem = memories(
      memory('k1-glyph', 'k1', { stability: 400, lastReview: T0, due: T0 + 200 * DAY }),
      memory('k1-read', 'k1', { due: T0 - DAY }),
      memory('k1-mean', 'k1', { due: T0 - 2 * DAY }),
    )
    const queue = buildQueue({ decks: [deck()], cards: [kanji('k1')], memories: mem, now: T0 })
    expect(queue.length).toBe(1)
    expect(queue[0]!.targetSideIds.sort()).toEqual(['k1-mean', 'k1-read'])
    expect(queueSize(queue)).toBe(2)
  })

  it('skips cards with nothing due, and deleted decks and cards', () => {
    const fresh = memories(
      memory('k1-glyph', 'k1', { due: T0 + DAY }),
      memory('k1-read', 'k1', { due: T0 + DAY }),
      memory('k1-mean', 'k1', { due: T0 + DAY }),
    )
    expect(buildQueue({ decks: [deck()], cards: [kanji('k1')], memories: fresh, now: T0 })).toEqual(
      [],
    )

    const gone = { ...kanji('k2'), deletedAt: T0 }
    expect(buildQueue({ decks: [deck()], cards: [gone], memories: memories(), now: T0 })).toEqual([])

    expect(
      buildQueue({
        decks: [deck({ deletedAt: T0 })],
        cards: [kanji('k3')],
        memories: memories(),
        now: T0,
      }),
    ).toEqual([])
  })

  it('scopes to the requested decks', () => {
    const other = deck({ id: 'deck-birds', name: 'Bird calls' })
    const cards = [kanji('k1'), { ...kanji('b1'), deckId: 'deck-birds' }]
    const queue = buildQueue({
      decks: [deck(), other],
      cards,
      memories: memories(),
      now: T0,
      deckIds: ['deck-birds'],
    })
    expect(queue.map((b) => b.cardId)).toEqual(['b1'])
  })

  it('caps the session when asked', () => {
    const cards = Array.from({ length: 10 }, (_, i) => kanji(`k${i}`))
    const queue = buildQueue({
      decks: [deck()],
      cards,
      memories: memories(),
      now: T0,
      maxBatches: 4,
    })
    expect(queue.length).toBe(4)
  })
})

describe('interleave', () => {
  it('alternates decks rather than running through one at a time', () => {
    const decks = [deck(), deck({ id: 'deck-birds', name: 'Bird calls' })]
    const cards = [
      ...Array.from({ length: 3 }, (_, i) => kanji(`k${i}`)),
      ...Array.from({ length: 3 }, (_, i) => ({ ...kanji(`b${i}`), deckId: 'deck-birds' })),
    ]
    const queue = buildQueue({ decks, cards, memories: memories(), now: T0 })
    const seen = queue.map((b) => b.deckId)
    expect(seen.length).toBe(6)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1])
  })

  it('falls back to the same deck once the others are exhausted', () => {
    const decks = [deck(), deck({ id: 'deck-birds' })]
    const cards = [
      kanji('k0'),
      kanji('k1'),
      kanji('k2'),
      { ...kanji('b0'), deckId: 'deck-birds' },
    ]
    const queue = buildQueue({ decks, cards, memories: memories(), now: T0 })
    expect(queue.length).toBe(4)
    expect(new Set(queue.map((b) => b.cardId)).size).toBe(4)
  })

  it('puts the most overdue card first', () => {
    const cards = [kanji('k1'), kanji('k2')]
    const mem = memories(
      memory('k1-glyph', 'k1', { due: T0 + 10 * DAY }),
      memory('k1-read', 'k1', { due: T0 - DAY }),
      memory('k1-mean', 'k1', { due: T0 + 10 * DAY }),
      memory('k2-glyph', 'k2', { due: T0 + 10 * DAY }),
      memory('k2-read', 'k2', { due: T0 - 30 * DAY }),
      memory('k2-mean', 'k2', { due: T0 + 10 * DAY }),
    )
    const queue = interleave(
      [buildBatch(deck(), cards[0]!, mem, T0)!, buildBatch(deck(), cards[1]!, mem, T0)!],
      mem,
      T0,
    )
    expect(queue.map((b) => b.cardId)).toEqual(['k2', 'k1'])
  })
})

describe('freeform decks', () => {
  const free = deck({ id: 'deck-misc', mode: 'freeform', fields: [] })
  const c = {
    id: 'm1',
    deckId: 'deck-misc',
    sides: [
      { id: 'm1-a', fieldId: null, label: 'front', kind: 'text' as const, value: 'a', tested: true },
      { id: 'm1-b', fieldId: null, label: 'back', kind: 'text' as const, value: 'b', tested: true },
      { id: 'm1-c', fieldId: null, label: 'src', kind: 'text' as const, value: 'c', tested: false },
    ],
    updatedAt: T0,
    deletedAt: null,
    seq: 0,
  }

  it('reads tested off the side rather than the deck', () => {
    const batch = buildBatch(free, c, memories(), T0)!
    expect(batch.targetSideIds).not.toContain('m1-c')
    expect(batch.contextSideIds).toEqual(['m1-c'])
  })

  it('ignores blank sides entirely', () => {
    const blanked = { ...c, sides: [c.sides[0]!, { ...c.sides[1]!, value: '   ' }, c.sides[2]!] }
    // Only one testable side left plus an untested one: still promptable.
    const batch = buildBatch(free, blanked, memories(), T0)!
    expect(batch.targetSideIds).toEqual(['m1-a'])
    expect(batch.cueSideId).toBe('m1-c')
  })
})

describe('retrievability drives the ramp', () => {
  it('falls as a side goes unreviewed', () => {
    const m = memory('k1-read', 'k1', { stability: 10, lastReview: T0, due: T0 + 10 * DAY })
    const fresh = retrievability(m, T0)
    const later = retrievability(m, T0 + 30 * DAY)
    expect(fresh).toBeGreaterThan(later)
    expect(fresh).toBeLessThanOrEqual(1)
    expect(later).toBeGreaterThan(0)
  })

  it('is zero for a side never reviewed', () => {
    const m = memory('k1-read', 'k1', { reps: 0, state: 0, lastReview: null })
    expect(retrievability(m, T0)).toBe(0)
  })
})
