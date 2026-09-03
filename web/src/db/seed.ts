/**
 * Demo content for development and screenshots. Not shipped behaviour — called
 * only from the dev console via `window.__seed()`.
 */
import { db } from './db.ts'
import { blankSide, createDeck, currentParams, saveCard } from './mutations.ts'
import { type Card, type Deck, type Grade, grade } from '@eidet/shared'

const KANJI: [string, string, string][] = [
  ['憂', 'ユウ', 'grief, melancholy'],
  ['慮', 'リョ', 'consider, deliberate'],
  ['憾', 'カン', 'regret, remorse'],
  ['懇', 'コン', 'sincere, cordial'],
  ['慕', 'ボ', 'yearn for, long for'],
]

const BIRDS: [string, string][] = [
  ['Winter wren', 'A long tumbling cascade, ten seconds without a breath'],
  ['Song thrush', 'Every phrase repeated two or three times'],
  ['Chiffchaff', 'Its own name, over and over, two notes'],
]

async function deckWith(
  name: string,
  fields: { name: string; tested: boolean }[],
  rows: string[][],
) {
  const id = await createDeck({
    name,
    mode: 'schema',
    fields: fields.map((f, i) => ({ id: `${name}-f${i}`, name: f.name, kind: 'text', tested: f.tested })),
  })
  const deck = (await db.decks.get(id)) as Deck
  for (const row of rows) {
    const card: Card = {
      id: crypto.randomUUID(),
      deckId: id,
      sides: deck.fields.map((f, i) => ({ ...blankSide(f.id), value: row[i] ?? '' })),
      updatedAt: Date.now(),
      deletedAt: null,
      seq: 0,
    }
    await saveCard(card)
  }
}

const DAY = 86_400_000

/**
 * Give the collection a plausible history so the ramp has a spread to show. A
 * brand-new collection is all-due by definition, which tells you nothing about
 * how the interface reads in normal use.
 */
async function backdate() {
  const params = await currentParams()
  const memories = await db.memories.toArray()
  for (const [i, m] of memories.entries()) {
    // Deterministic but varied: some sides well-learned, some struggling.
    const sessions = (i % 6) + 2
    const strong = i % 4 !== 0
    let memory = m
    let at = Date.now() - 90 * DAY
    for (let r = 0; r < sessions; r++) {
      const rating = (strong ? (r === 0 ? 3 : 3 + (i % 2)) : ((r % 2) + 1)) as Grade
      const next = grade({ reviewId: crypto.randomUUID(), memory, rating, cueSideId: null, now: at, params })
      await db.reviews.put(next.review)
      memory = next.memory
      at = Math.min(memory.due, Date.now() - DAY)
    }
    await db.memories.put(memory)
  }
}

export async function seed() {
  await db.delete()
  await db.open()
  await deckWith(
    'Kanji',
    [
      { name: 'glyph', tested: true },
      { name: 'reading', tested: true },
      { name: 'meaning', tested: true },
    ],
    KANJI.map((k) => [...k]),
  )
  await deckWith(
    'Bird calls',
    [
      { name: 'species', tested: true },
      { name: 'song', tested: true },
    ],
    BIRDS.map((b) => [...b]),
  )
  await backdate()
  location.reload()
}
