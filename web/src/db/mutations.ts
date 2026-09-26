/**
 * Every write the app makes. See DESIGN.md §5, §6.
 *
 * Two rules hold throughout:
 *  - a write lands in IndexedDB first and is queued for the server second, so
 *    nothing here waits on the network;
 *  - grading writes the review and the memory in one transaction, because the
 *    memory is only ever the newest review's `memoryAfter` and the two must
 *    never disagree.
 */
import {
  type Card,
  type CardId,
  type Deck,
  type DeckId,
  type Grade,
  type Memory,
  type ParamSet,
  type ReviewId,
  type Side,
  type SideId,
  DEFAULT_PARAMS,
  defaultParamSet,
  grade as gradeSide,
  newMemory,
  paramSet,
  replay,
  resetReview,
  sideFilled,
  sideTested,
} from '@eidet/shared'
import { db, enqueue, newestReview, outboxKey, withSendLock } from './db.ts'

export const newId = () => crypto.randomUUID()

/** The parameter set in force, created on first use. */
export async function currentParams(now = Date.now()): Promise<ParamSet> {
  const stored = await db.ui.get('params')
  if (stored) {
    const hash = stored.value as string
    const set = await db.paramSets.get(hash)
    if (set) return upgradeParams(set)
  }
  const set = defaultParamSet(now)
  await setParams(set, now)
  return set
}

/**
 * Fill in a field a set predates. `learningSteps` joined the parameter set
 * after the first release, and a row written before that genuinely ran on the
 * FSRS defaults — so this reports what was already true rather than changing
 * anything. The hash is deliberately left alone: every review carries it as the
 * record of which parameters produced it, and re-hashing would orphan them.
 *
 * Pure on purpose. `currentParams` is read through `useLiveQuery`, and a write
 * on that path invalidates the very query that made it.
 */
export function upgradeParams(set: ParamSet): ParamSet {
  return set.learningSteps ? set : { ...set, learningSteps: [...DEFAULT_PARAMS.learning_steps] }
}

/** Adopt a parameter set. Immutable and content-hashed, so this is a put. */
export async function setParams(set: ParamSet, now = Date.now()) {
  await db.paramSets.put(set)
  await db.ui.put({ key: 'params', value: set.hash })
  await enqueue('paramSets', set.hash, now)
}

// ------------------------------------------------------------------ decks

export async function createDeck(
  input: Pick<Deck, 'name' | 'mode' | 'fields'> & Partial<Pick<Deck, 'cuePreference'>>,
  now = Date.now(),
): Promise<DeckId> {
  const count = await db.decks.count()
  const deck: Deck = {
    id: newId(),
    name: input.name,
    mode: input.mode,
    fields: input.fields,
    cuePreference: input.cuePreference ?? 'auto',
    order: count,
    updatedAt: now,
    deletedAt: null,
    seq: 0,
  }
  await db.decks.put(deck)
  await enqueue('decks', deck.id, now)
  return deck.id
}

/**
 * A deck's `mode` is fixed at creation: its cards' sides are shaped by it, and
 * switching would leave every one of them resolving as unlabelled and untested.
 */
export type DeckPatch = Partial<Omit<Deck, 'id' | 'mode' | 'updatedAt' | 'seq'>>

export async function updateDeck(id: DeckId, patch: DeckPatch, now = Date.now()) {
  const deck = await db.decks.get(id)
  if (!deck) return
  const next: Deck = { ...deck, ...patch, id, updatedAt: now }
  await db.decks.put(next)
  await enqueue('decks', id, now)
  // A field's `tested` flag lives on the deck, so this is where a side gains
  // or loses its schedule in a schema deck.
  if (patch.fields) await reconcileDeck(next, now)
}

/**
 * Nudge a deck one place up or down the home screen.
 *
 * Both decks are rewritten with fresh `order` values and both are enqueued, so
 * the move syncs as an ordinary last-write-wins edit like any other deck field.
 */
export async function moveDeck(id: DeckId, by: -1 | 1, now = Date.now()) {
  const decks = await db.decks.filter((d) => d.deletedAt === null).sortBy('order')
  const at = decks.findIndex((d) => d.id === id)
  const to = at + by
  if (at === -1 || to < 0 || to >= decks.length) return

  const reordered = [...decks]
  const [moved] = reordered.splice(at, 1)
  reordered.splice(to, 0, moved!)

  // Renumber the pair that actually moved rather than the whole list, so a
  // reorder is a two-row change however long the list is.
  await Promise.all(
    reordered
      .map((deck, order) => ({ deck, order }))
      .filter(({ deck, order }) => deck.order !== order)
      .map(({ deck, order }) => updateDeck(deck.id, { order }, now)),
  )
}

/** Soft delete: a tombstone, so the deletion itself syncs. */
export async function deleteDeck(id: DeckId, now = Date.now()) {
  const cards = await db.cards.where('deckId').equals(id).toArray()
  await updateDeck(id, { deletedAt: now }, now)
  // The cards go with it. `buildQueue` already skips a card whose deck is gone,
  // but the memories do not go anywhere on their own, and the home screen counts
  // memories — so a deleted deck kept inflating "Review N sides" past what the
  // session would actually ask.
  for (const card of cards) {
    if (card.deletedAt === null) await deleteCard(card.id, now)
  }
}

// ------------------------------------------------------------------ cards

/**
 * Saving a card reconciles its sides' memories: a newly filled testable side
 * gets a fresh memory due immediately, and a side that was emptied or untested
 * loses its schedule. Editing a side's *content* deliberately does not reset
 * its memory — `resetSide` is the explicit action for that.
 */
export async function saveCard(card: Card, now = Date.now()) {
  const deck = await db.decks.get(card.deckId)
  if (!deck) throw new Error(`saveCard: no deck ${card.deckId}`)

  await db.transaction('rw', [db.cards, db.memories, db.reviews, db.outbox], async () => {
    await db.cards.put({ ...card, updatedAt: now })
    await reconcileMemories(deck, card, now)
    await enqueue('cards', card.id, now)
  })
}

/**
 * Bring a card's memories in line with which of its sides should hold one: a
 * filled, tested side of a live card in a live deck. Every path that can change
 * that answer ends here — saving a card, editing a deck's fields, and pulling
 * either from the server.
 *
 * A side that gains a schedule takes its newest review's `memoryAfter` if it
 * has one — memory is derived from the log (§5), so a side that was untested
 * for a while picks up where it left off rather than starting over. Only a side
 * with no history starts fresh, due immediately.
 *
 * Call inside a transaction over `memories` and `reviews`.
 */
export async function reconcileMemories(deck: Deck | undefined, card: Card, now: number) {
  const live = deck !== undefined && deck.deletedAt === null && card.deletedAt === null
  const shouldSchedule = new Set(
    live ? card.sides.filter((s) => sideFilled(s) && sideTested(deck, s)).map((s) => s.id) : [],
  )
  const existing = await db.memories.where('cardId').equals(card.id).toArray()
  const have = new Set(existing.map((m) => m.sideId))

  const stale = existing.filter((m) => !shouldSchedule.has(m.sideId)).map((m) => m.sideId)
  if (stale.length > 0) await db.memories.bulkDelete(stale)
  for (const sideId of shouldSchedule) {
    if (have.has(sideId)) continue
    await db.memories.put(await restoredMemory({ sideId, cardId: card.id, deckId: card.deckId }, now))
  }
}

/** Every card of a deck, reconciled after the deck itself changed. */
export async function reconcileDeck(deck: Deck, now: number) {
  await db.transaction('rw', [db.cards, db.memories, db.reviews], async () => {
    const cards = await db.cards.where('deckId').equals(deck.id).toArray()
    for (const card of cards) await reconcileMemories(deck, card, now)
  })
}

/** What a side's memory is by the log: its newest review's snapshot, or new. */
async function restoredMemory(ids: Pick<Memory, 'sideId' | 'cardId' | 'deckId'>, now: number) {
  return (await newestReview(ids.sideId))?.memoryAfter ?? newMemory(ids, now)
}

export function blankSide(fieldId: string | null, kind: Side['kind'] = 'text'): Side {
  return { id: newId(), fieldId, label: null, kind, value: '', tested: null }
}

/** A card shaped for its deck: one slot per field in a schema deck. */
export function blankCard(deck: Deck, now = Date.now()): Card {
  const sides =
    deck.mode === 'schema'
      ? deck.fields.map((f) => blankSide(f.id, f.kind))
      : [
          { ...blankSide(null), label: 'front', tested: true },
          { ...blankSide(null), label: 'back', tested: true },
        ]
  return { id: newId(), deckId: deck.id, sides, updatedAt: now, deletedAt: null, seq: 0 }
}

export async function deleteCard(id: CardId, now = Date.now()) {
  const card = await db.cards.get(id)
  if (!card) return
  await db.transaction('rw', [db.cards, db.memories, db.outbox], async () => {
    await db.cards.put({ ...card, deletedAt: now, updatedAt: now })
    await db.memories.where('cardId').equals(id).delete()
    await enqueue('cards', id, now)
  })
}

// ----------------------------------------------------------------- reviews

export interface RevealGrades {
  cardId: CardId
  deckId: DeckId
  cueSideId: SideId
  /** Sides being asked, and the grade each is getting. */
  grades: { sideId: SideId; rating: Grade }[]
}

/**
 * Commit one reveal. Every side of the card is graded in a single transaction,
 * so a reload can never land between two sides of the same reveal.
 */
export async function commitReveal(reveal: RevealGrades, now = Date.now()): Promise<ReviewId[]> {
  const params = await currentParams(now)
  const written: ReviewId[] = []
  await db.transaction('rw', [db.memories, db.reviews, db.outbox], async () => {
    for (const { sideId, rating } of reveal.grades) {
      // A missing memory is a bug elsewhere (every scheduled side should have
      // one), but dropping the grade on the floor would hide it as a review
      // that silently did nothing. Grade from what the log says instead.
      const memory =
        (await db.memories.get(sideId)) ??
        (await restoredMemory({ sideId, cardId: reveal.cardId, deckId: reveal.deckId }, now))
      const result = gradeSide({
        reviewId: newId(),
        memory,
        rating,
        cueSideId: reveal.cueSideId,
        now,
        params,
      })
      await db.memories.put(result.memory)
      await db.reviews.put(result.review)
      await enqueue('reviews', result.review.id, now)
      written.push(result.review.id)
    }
  })
  return written
}

/**
 * Is every review of this commit still sitting in the outbox? Undo is only
 * offered while that holds. Reviews are append-only and immutable (§5) — the
 * property that makes sync conflict-free — so one that has reached the server
 * is never withdrawn. Unsent, it has no such standing and can simply go.
 *
 * Advisory: this is what decides whether the affordance is drawn. The answer
 * that counts is taken again inside `undoCommit`, where a push cannot move
 * underneath it.
 */
export async function isUnsent(reviewIds: ReviewId[]): Promise<boolean> {
  if (reviewIds.length === 0) return false
  const keys = await db.outbox.bulkGet(reviewIds.map((id) => outboxKey('reviews', id)))
  return keys.every(Boolean)
}

/**
 * Take back one commit, and report whether it was still takeable. False means a
 * push got there first and the reviews stand — the caller must not rewind
 * anything, or the session goes back a card while the log keeps the grade and
 * the next press writes a second review for the same side.
 *
 * `scheduler.rollback` is not needed: every review row already carries the exact
 * memory it replaced, which is the same reason §2 gives for storing the snapshot
 * in the first place. A null `memoryBefore` means the side had never been
 * reviewed, so it goes back to being new.
 *
 * Under the send lock, and re-reading the outbox inside the transaction: the
 * test and the deletion have to be one indivisible step against a push that
 * clears the outbox, or this becomes the withdrawal of a review the server has
 * already taken — which the next pull simply restores. See `withSendLock`.
 */
export async function undoCommit(reviewIds: ReviewId[], now = Date.now()): Promise<boolean> {
  if (reviewIds.length === 0) return false
  return withSendLock(() =>
    db.transaction('rw', [db.memories, db.reviews, db.outbox], async () => {
      const queued = await db.outbox.bulkGet(reviewIds.map((id) => outboxKey('reviews', id)))
      if (!queued.every(Boolean)) return false
      for (const id of reviewIds) {
        const review = await db.reviews.get(id)
        if (!review) continue
        const ids = { sideId: review.sideId, cardId: review.cardId, deckId: review.deckId }
        await db.memories.put(review.memoryBefore ?? newMemory(ids, now))
        await db.reviews.delete(id)
        await db.outbox.delete(outboxKey('reviews', id))
      }
      return true
    }),
  )
}

/**
 * Forget a side and start it over. Recorded as a reset review (§5) rather than
 * a bare memory write, so it syncs to other devices and a replay keeps it; the
 * reviews before it stay in the log.
 */
export async function resetSide(sideId: SideId, now = Date.now()) {
  const params = await currentParams(now)
  await db.transaction('rw', [db.memories, db.reviews, db.outbox], async () => {
    const memory = await db.memories.get(sideId)
    if (!memory) return
    const result = resetReview({ reviewId: newId(), memory, now, params })
    await db.memories.put(result.memory)
    await db.reviews.put(result.review)
    await enqueue('reviews', result.review.id, now)
  })
}

/**
 * Adopt new retention or learning steps: a new immutable set under the same
 * weights, then a replay of every side's log under it (§2).
 */
export async function changeParams(
  base: ParamSet,
  change: Pick<ParamSet, 'requestRetention' | 'learningSteps'>,
  now = Date.now(),
) {
  const next = paramSet([...base.w], change.requestRetention, change.learningSteps, now)
  await setParams(next, now)
  await replayAll(next)
}

/**
 * Rebuild every memory from the review log under new parameters (§2). Slow and
 * deliberate — run only when the weights change, never on a read path.
 */
export async function replayAll(params: ParamSet) {
  const memories = await db.memories.toArray()
  const rebuilt: Memory[] = []
  for (const m of memories) {
    const reviews = await db.reviews.where('sideId').equals(m.sideId).toArray()
    rebuilt.push(
      replay({ sideId: m.sideId, cardId: m.cardId, deckId: m.deckId }, reviews, params),
    )
  }
  await db.memories.bulkPut(rebuilt)
}
