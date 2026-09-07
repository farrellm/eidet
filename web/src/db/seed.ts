/**
 * Demo content for development and screenshots. Not shipped behaviour — called
 * only from the dev console via `window.__seed()`.
 */
import { db } from './db.ts'
import { blankSide, createDeck, currentParams, deleteDeck, saveCard } from './mutations.ts'
import { type Card, type Deck, type Grade, grade } from '@eidet/shared'

const KANJI: [string, string, string][] = [
  ['憂', 'ユウ', 'grief, melancholy'],
  ['慮', 'リョ', 'consider, deliberate'],
  ['憾', 'カン', 'regret, remorse'],
  ['懇', 'コン', 'sincere, cordial'],
  ['慕', 'ボ', 'yearn for, long for'],
  ['慰', 'イ', 'consolation, amusement'],
  ['憧', 'ショウ', 'yearn after, long for'],
  ['懲', 'チョウ', 'chastise, punish'],
  ['憬', 'ケイ', 'hanker after'],
  ['惧', 'グ', 'fear, dread'],
  ['愕', 'ガク', 'astonishment, shock'],
  ['惰', 'ダ', 'laziness, inactivity'],
  ['慨', 'ガイ', 'rue, lament, deplore'],
  ['憤', 'フン', 'indignation, resentment'],
  ['懐', 'カイ', 'nostalgia, bosom, heart'],
]

const BIRDS: [string, string][] = [
  ['Winter wren', 'A long tumbling cascade, ten seconds without a breath'],
  ['Song thrush', 'Every phrase repeated two or three times'],
  ['Chiffchaff', 'Its own name, over and over, two notes'],
  ['Blackcap', 'A scratchy warble that opens out into clear fluting'],
  ['Willow warbler', 'A wistful descending scale, fading at the end'],
  ['Garden warbler', 'Like a blackcap but even, and it never resolves'],
  ['Nuthatch', 'A loud ringing whistle, all on one note'],
  ['Treecreeper', 'Thin and high, a phrase that falls then flicks up'],
  ['Mistle thrush', 'Short wild phrases with long silences between'],
  ['Redstart', 'A brief sweet opening, then a dry rattle'],
]

/** Four sides, one of them untested — context that is shown but never graded. */
const ANATOMY: [string, string, string, string][] = [
  ['Biceps brachii', 'Flexes the elbow, supinates the forearm', 'Musculocutaneous', 'Two heads, hence the name'],
  ['Brachialis', 'Flexes the elbow', 'Musculocutaneous', 'The workhorse under the biceps'],
  ['Triceps brachii', 'Extends the elbow', 'Radial', 'Long head crosses the shoulder too'],
  ['Deltoid', 'Abducts the arm past fifteen degrees', 'Axillary', 'Supraspinatus starts the movement'],
  ['Supraspinatus', 'Starts abduction of the arm', 'Suprascapular', 'First of the rotator cuff to tear'],
  ['Infraspinatus', 'Rotates the arm laterally', 'Suprascapular', ''],
  ['Teres minor', 'Rotates the arm laterally', 'Axillary', 'The only cuff muscle on the axillary'],
  ['Subscapularis', 'Rotates the arm medially', 'Upper and lower subscapular', ''],
  ['Serratus anterior', 'Protracts and rotates the scapula', 'Long thoracic', 'Winged scapula when it fails'],
  ['Latissimus dorsi', 'Extends, adducts and medially rotates the arm', 'Thoracodorsal', ''],
  ['Pronator teres', 'Pronates the forearm', 'Median', ''],
  ['Supinator', 'Supinates the forearm', 'Radial', 'Deep branch pierces it'],
  ['Flexor carpi radialis', 'Flexes and abducts the wrist', 'Median', ''],
  ['Extensor carpi ulnaris', 'Extends and adducts the wrist', 'Radial', ''],
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
  // Tombstone what is here rather than dropping the database. A bare wipe takes
  // the sync cursor with it, so the next pull faithfully restores every deck
  // from the server and you end up with two of everything.
  for (const deck of await db.decks.toArray()) {
    if (deck.deletedAt === null) await deleteDeck(deck.id)
  }
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
    'Anatomy',
    [
      { name: 'structure', tested: true },
      { name: 'action', tested: true },
      { name: 'innervation', tested: true },
      { name: 'note', tested: false },
    ],
    ANATOMY.map((a) => [...a]),
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
