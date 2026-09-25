/**
 * Resolving a side against its deck. See DESIGN.md §1 (deck field model).
 *
 * A schema deck keeps a side's name and `tested` flag on the deck field, a
 * freeform deck keeps them on the side. Everything downstream goes through
 * these rather than reading either pair directly.
 */
import type { Card, Deck, Side } from './types.ts'

/** The display label for a side, resolved against its deck. */
export function sideLabel(deck: Deck, side: Side): string {
  if (deck.mode === 'freeform') return side.label ?? ''
  return deck.fields.find((f) => f.id === side.fieldId)?.name ?? ''
}

/** Whether a side is scheduled and graded, resolved against its deck. */
export function sideTested(deck: Deck, side: Side): boolean {
  if (deck.mode === 'freeform') return side.tested ?? false
  return deck.fields.find((f) => f.id === side.fieldId)?.tested ?? false
}

/** A side with no content holds no schedule and is never shown. */
export function sideFilled(side: Side): boolean {
  return side.value.trim().length > 0
}

/**
 * A schema deck's card, with one slot per deck field in the deck's order.
 *
 * Fields can be added to a deck after its cards exist, and the card rows are
 * not rewritten when that happens — so without this a new field could never
 * be filled on an existing card. Sides whose field has since been removed are
 * kept at the end rather than dropped: that is the user's content. Returns the
 * card itself when it already lines up, so a caller can tell nothing changed.
 * `newId` names any slot it has to add; this package has no id source of its own.
 */
export function alignSidesToDeck(deck: Deck, card: Card, newId: () => string): Card {
  if (deck.mode !== 'schema') return card
  const byField = new Map(card.sides.map((s) => [s.fieldId, s]))
  const known = new Set(deck.fields.map((f) => f.id))
  const sides: Side[] = [
    ...deck.fields.map(
      (f): Side =>
        byField.get(f.id) ?? {
          id: newId(),
          fieldId: f.id,
          label: null,
          kind: f.kind,
          value: '',
          tested: null,
        },
    ),
    ...card.sides.filter((s) => s.fieldId === null || !known.has(s.fieldId)),
  ]
  const unchanged = sides.length === card.sides.length && sides.every((s, i) => s === card.sides[i])
  return unchanged ? card : { ...card, sides }
}
