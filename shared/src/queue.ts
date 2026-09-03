/**
 * Building a review session. See DESIGN.md §1 (the review loop).
 *
 * Pure functions over plain data — no clock, no database, no React. Screens
 * never do date maths; they call in here.
 */
import { retrievability, scheduler } from './schedule.ts'
import {
  type Card,
  type CardBatch,
  type Deck,
  type DeckId,
  type Memory,
  type Side,
  type SideId,
  sideFilled,
  sideTested,
} from './types.ts'

export interface QueueInput {
  decks: Deck[]
  cards: Card[]
  memories: Map<SideId, Memory>
  now: number
  /** Empty means every deck. */
  deckIds?: DeckId[]
  /** Cap the session length; unset means every due card. */
  maxBatches?: number
}

/**
 * A card is reviewable when it has at least one testable side to recall and at
 * least one other filled side to prompt with. A card with a single side can
 * never be reviewed — there is nothing to cue it from.
 */
function reviewableSides(deck: Deck, card: Card): { tested: Side[]; all: Side[] } {
  const all = card.sides.filter(sideFilled)
  return { all, tested: all.filter((s) => sideTested(deck, s)) }
}

/**
 * Cue selection (§1 step 2).
 *
 * Preference order:
 *  1. the deck's pinned cue field, if it is not itself being asked;
 *  2. the best-known *tested* side that is not being asked — the one you are
 *     most likely to recognise makes the clearest prompt;
 *  3. failing that, lift the best-known target out to prompt with, which keeps
 *     the natural direction of a card whose sides are all due. The lifted side
 *     is not asked and not graded now, and stays due for a later session;
 *  4. only then an untested side, as a last resort when there is a single
 *     target and nothing better to prompt with. A source note makes a poor
 *     prompt, so it is reached for last rather than first.
 *
 * A side that has never been reviewed scores 0 and so sorts last among
 * candidates, which is right: an unseen side is a poor prompt.
 */
export function selectCue(
  deck: Deck,
  sides: Side[],
  targets: Side[],
  memories: Map<SideId, Memory>,
  now: number,
  fsrsInstance = scheduler(),
): { cue: Side; targets: Side[] } | null {
  const targetIds = new Set(targets.map((s) => s.id))
  const score = (s: Side) => {
    const m = memories.get(s.id)
    return m ? retrievability(m, now, fsrsInstance) : 0
  }
  const best = (pool: Side[]) => [...pool].sort((a, b) => score(b) - score(a))[0]

  const pinned =
    deck.cuePreference !== 'auto'
      ? sides.find((s) => s.fieldId === deck.cuePreference && !targetIds.has(s.id))
      : undefined
  if (pinned) return { cue: pinned, targets }

  const outside = sides.filter((s) => !targetIds.has(s.id))

  const testedOutside = best(outside.filter((s) => sideTested(deck, s)))
  if (testedOutside) return { cue: testedOutside, targets }

  if (targets.length >= 2) {
    const lifted = best(targets)!
    return { cue: lifted, targets: targets.filter((s) => s.id !== lifted.id) }
  }

  const fallback = outside[0]
  if (fallback) return { cue: fallback, targets }

  return null
}

/** Build one card's turn, or null if it has nothing due or cannot be prompted. */
export function buildBatch(
  deck: Deck,
  card: Card,
  memories: Map<SideId, Memory>,
  now: number,
  fsrsInstance = scheduler(),
): CardBatch | null {
  const { all, tested } = reviewableSides(deck, card)
  if (all.length < 2 || tested.length === 0) return null

  const due = tested.filter((s) => {
    const m = memories.get(s.id)
    return m === undefined || m.due <= now
  })
  if (due.length === 0) return null

  const selected = selectCue(deck, all, due, memories, now, fsrsInstance)
  if (selected === null) return null

  const shown = new Set([selected.cue.id, ...selected.targets.map((s) => s.id)])
  return {
    cardId: card.id,
    deckId: card.deckId,
    cueSideId: selected.cue.id,
    targetSideIds: selected.targets.map((s) => s.id),
    contextSideIds: all.filter((s) => !shown.has(s.id)).map((s) => s.id),
  }
}

/** How overdue a batch's most-overdue target is. Unseen sides sort first. */
function urgency(batch: CardBatch, memories: Map<SideId, Memory>, now: number): number {
  let worst = 0
  for (const id of batch.targetSideIds) {
    const m = memories.get(id)
    const overdue = m === undefined ? Number.MAX_SAFE_INTEGER : now - m.due
    if (overdue > worst) worst = overdue
  }
  return worst
}

/**
 * Interleave decks so consecutive cards rarely come from the same one — studying
 * a hundred kanji in a row is worse practice than alternating, and it is also
 * duller. Always takes the most urgent available batch, but skips the deck used
 * immediately before when another deck still has work.
 */
export function interleave(
  batches: CardBatch[],
  memories: Map<SideId, Memory>,
  now: number,
): CardBatch[] {
  const byDeck = new Map<DeckId, CardBatch[]>()
  for (const b of batches) {
    const list = byDeck.get(b.deckId)
    if (list) list.push(b)
    else byDeck.set(b.deckId, [b])
  }
  for (const list of byDeck.values()) {
    list.sort((a, b) => urgency(b, memories, now) - urgency(a, memories, now))
  }

  const out: CardBatch[] = []
  let previous: DeckId | null = null
  while (out.length < batches.length) {
    let pick: DeckId | null = null
    let best = -1
    for (const [deckId, list] of byDeck) {
      const head = list[0]
      if (head === undefined) continue
      if (deckId === previous && byDeck.size > 1) {
        // Only fall back to the previous deck if nothing else is left.
        const others = [...byDeck].some(([d, l]) => d !== deckId && l.length > 0)
        if (others) continue
      }
      const u = urgency(head, memories, now)
      if (u > best) {
        best = u
        pick = deckId
      }
    }
    if (pick === null) break
    out.push(byDeck.get(pick)!.shift()!)
    previous = pick
  }
  return out
}

/**
 * The whole queue for a session, built once up front.
 *
 * Building it eagerly is what makes the sight cooldown structural: a card
 * appears exactly once, all of its due sides land in a single reveal, and a
 * side can therefore never be shown as a cue and then asked as a target.
 */
export function buildQueue(input: QueueInput): CardBatch[] {
  const { decks, cards, memories, now, deckIds, maxBatches } = input
  const scope = deckIds && deckIds.length > 0 ? new Set(deckIds) : null
  const deckById = new Map(decks.filter((d) => d.deletedAt === null).map((d) => [d.id, d]))
  const fsrsInstance = scheduler()

  const batches: CardBatch[] = []
  for (const card of cards) {
    if (card.deletedAt !== null) continue
    if (scope && !scope.has(card.deckId)) continue
    const deck = deckById.get(card.deckId)
    if (!deck) continue
    const batch = buildBatch(deck, card, memories, now, fsrsInstance)
    if (batch) batches.push(batch)
  }

  const ordered = interleave(batches, memories, now)
  return maxBatches === undefined ? ordered : ordered.slice(0, maxBatches)
}

/** Total sides that will be asked — the number the home screen's action names. */
export function queueSize(queue: CardBatch[]): number {
  return queue.reduce((n, b) => n + b.targetSideIds.length, 0)
}
