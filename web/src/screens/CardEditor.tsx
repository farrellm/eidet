/**
 * The card editor. See DESIGN.md §4.
 *
 * All sides together, always — scheduling is per side, but storage and editing
 * are per card. Each side shows its own schedule read-only so an edit is
 * informed; changing a side's content deliberately does not reset its memory.
 *
 * The draft is persisted on every keystroke, so a reload mid-edit comes back to
 * the same half-typed card (§6).
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { type Card, type Deck, type Side, sideLabel, sideTested } from '@eidet/shared'
import { db } from '../db/db.ts'
import { blankCard, blankSide, deleteCard, newId, saveCard } from '../db/mutations.ts'
import { resetSide } from '../db/mutations.ts'
import { formatWhen } from '../ui/format.ts'
import { Ramp, memoryRamp } from '../ui/Ramp.tsx'
import { ImageSideInput } from '../ui/ImageSideInput.tsx'

export function CardEditor() {
  const { deckId = '', cardId = '' } = useParams()
  const navigate = useNavigate()
  const isNew = cardId === 'new'
  const draftKey = `draft:${deckId}:${cardId}`

  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const stored = useLiveQuery(() => (isNew ? undefined : db.cards.get(cardId)), [cardId, isNew])
  const [card, setCard] = useState<Card | null>(null)
  const loaded = useRef(false)

  // Restore a draft before falling back to the stored card, so a reload
  // mid-edit returns to the unsaved text rather than discarding it.
  useEffect(() => {
    if (loaded.current || !deck) return
    if (!isNew && stored === undefined) return
    let live = true
    db.ui.get(draftKey).then((row) => {
      if (!live || loaded.current) return
      loaded.current = true
      if (row) setCard(row.value as Card)
      else setCard(isNew ? blankCard(deck) : (stored as Card))
    })
    return () => {
      live = false
    }
  }, [deck, stored, isNew, draftKey])

  if (!deck || !card) return <div className="app" />

  const edit = (next: Card) => {
    setCard(next)
    void db.ui.put({ key: draftKey, value: next })
  }

  const setSide = (id: string, patch: Partial<Side>) =>
    edit({ ...card, sides: card.sides.map((s) => (s.id === id ? { ...s, ...patch } : s)) })

  const save = async () => {
    await saveCard(card)
    await db.ui.delete(draftKey)
    navigate(`/deck/${deckId}`)
  }

  const discard = async () => {
    await db.ui.delete(draftKey)
    navigate(`/deck/${deckId}`)
  }

  const remove = async () => {
    await deleteCard(card.id)
    await db.ui.delete(draftKey)
    navigate(`/deck/${deckId}`)
  }

  const usable = card.sides.filter((s) => s.value.trim().length > 0).length >= 2

  return (
    <div className="app">
      <div className="strip">
        <button className="strip__back" onClick={discard} aria-label="Discard and go back">
          ‹
        </button>
        <span>{isNew ? 'New card' : 'Edit card'}</span>
        <span className="strip__spacer" />
        {!isNew ? (
          <button className="link" onClick={remove}>
            Delete card
          </button>
        ) : null}
      </div>

      <div className="editor">
        {card.sides.map((side, i) => (
          <SideEditor
            key={side.id}
            deck={deck}
            side={side}
            // Order is the card's own, so it only means anything where the card
            // owns its sides. A schema deck's order belongs to the deck.
            onMove={
              deck.mode === 'freeform'
                ? (by) => edit({ ...card, sides: moveSide(card.sides, i, by) })
                : undefined
            }
            first={i === 0}
            last={i === card.sides.length - 1}
            onChange={(patch) => setSide(side.id, patch)}
            onRemove={
              deck.mode === 'freeform'
                ? () => edit({ ...card, sides: card.sides.filter((s) => s.id !== side.id) })
                : undefined
            }
          />
        ))}

        {deck.mode === 'freeform' ? (
          <button
            className="action action--quiet"
            onClick={() =>
              edit({
                ...card,
                sides: [...card.sides, { ...blankSide(null), id: newId(), label: '', tested: true }],
              })
            }
          >
            Add side
          </button>
        ) : null}
      </div>

      <div className="dock">
        <button className="action" onClick={save} disabled={!usable}>
          Save card
        </button>
        {!usable ? (
          <p className="rest">A card needs two filled sides: one to prompt with, one to recall.</p>
        ) : null}
      </div>
    </div>
  )
}

/** Sides in a new order, with `at` shifted one place. */
function moveSide(sides: Side[], at: number, by: -1 | 1): Side[] {
  const to = at + by
  if (to < 0 || to >= sides.length) return sides
  const next = [...sides]
  const [moved] = next.splice(at, 1)
  next.splice(to, 0, moved!)
  return next
}

function SideEditor({
  deck,
  side,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  deck: Deck
  side: Side
  first: boolean
  last: boolean
  onChange: (patch: Partial<Side>) => void
  onMove?: ((by: -1 | 1) => void) | undefined
  onRemove?: (() => void) | undefined
}) {
  const memory = useLiveQuery(() => db.memories.get(side.id), [side.id])
  const now = Date.now()

  return (
    <section className="field">
      <div className="field__head">
        {deck.mode === 'freeform' ? (
          <input
            className="field__label-input"
            value={side.label ?? ''}
            placeholder="Side name"
            onChange={(e) => onChange({ label: e.target.value })}
            aria-label="Side name"
          />
        ) : (
          <span className="label">{sideLabel(deck, side)}</span>
        )}
        <span className="field__meta">
          {deck.mode === 'freeform' ? (
            <label className="toggle">
              <input
                type="checkbox"
                checked={side.tested ?? false}
                onChange={(e) => onChange({ tested: e.target.checked })}
              />
              <span className="label">Test this</span>
            </label>
          ) : null}
          {onMove ? (
            <>
              <button
                className="link"
                onClick={() => onMove(-1)}
                disabled={first}
                aria-label={`Move ${sideLabel(deck, side) || 'this side'} up`}
              >
                Up
              </button>
              <button
                className="link"
                onClick={() => onMove(1)}
                disabled={last}
                aria-label={`Move ${sideLabel(deck, side) || 'this side'} down`}
              >
                Down
              </button>
            </>
          ) : null}
          {onRemove ? (
            <button className="link" onClick={onRemove}>
              Remove
            </button>
          ) : null}
        </span>
      </div>

      {side.kind === 'image' ? (
        <ImageSideInput side={side} onChange={onChange} />
      ) : (
        <textarea
          className="field__input content"
          value={side.value}
          rows={2}
          onChange={(e) => onChange({ value: e.target.value })}
          aria-label={sideLabel(deck, side) || 'Side content'}
        />
      )}

      {sideTested(deck, side) ? (
        <p className="field__schedule">
          {memory ? (
            <>
              {/* §4 wants the side's strength here too. It is the same ramp as
                  everywhere else, not a spelled-out R. */}
              <Ramp step={memoryRamp(memory, now)} />
              <span className="num">due {formatWhen(memory.due, now)}</span>
              <span className="num">
                {memory.reps} {memory.reps === 1 ? 'review' : 'reviews'}
              </span>
              {memory.reps > 0 ? (
                <button className="link" onClick={() => resetSide(side.id)}>
                  Reset schedule
                </button>
              ) : null}
            </>
          ) : (
            <span className="num">not scheduled yet</span>
          )}
        </p>
      ) : null}
    </section>
  )
}
