/**
 * One deck: its cards, and the way in to editing them. See DESIGN.md §4.
 *
 * Each card row shows its sides as ramp marks, so which cards are decaying is
 * visible without opening anything.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { type Card, type Deck, type Memory, sideFilled, sideLabel, sideTested } from '@eidet/shared'
import { db } from '../db/db.ts'
import { startSession } from '../session/session.ts'
import { Ramp, memoryRamp } from '../ui/Ramp.tsx'

export function DeckScreen() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const now = Date.now()
  const [query, setQuery] = useState('')
  const list = useScrollMemory(`scroll:deck:${deckId}`)

  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(
    () => db.cards.where('deckId').equals(deckId).filter((c) => c.deletedAt === null).toArray(),
    [deckId],
  )
  const memories = useLiveQuery(
    () => db.memories.where('deckId').equals(deckId).toArray(),
    [deckId],
  )

  if (!deck || !cards || !memories) return <div className="app" />

  const due = memories.filter((m) => m.due <= now).length
  const byCard = new Map<string, Memory[]>()
  for (const m of memories) {
    const list = byCard.get(m.cardId)
    if (list) list.push(m)
    else byCard.set(m.cardId, [m])
  }

  // Search runs over every side's text, because any side can be the one you
  // remember a card by — there is no "front" to privilege.
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? cards.filter((c) =>
        c.sides.some((s) => s.kind === 'text' && s.value.toLowerCase().includes(needle)),
      )
    : cards

  const start = async () => {
    const session = await startSession([deckId], Date.now())
    if (session) navigate(`/review/${session.id}`)
  }

  return (
    <div className="app">
      <div className="strip">
        <button className="strip__back" onClick={() => navigate('/')} aria-label="Back to decks">
          ‹
        </button>
        <span>{deck.name}</span>
        <span className="strip__spacer" />
        <button className="link" onClick={() => navigate(`/deck/${deckId}/settings`)}>
          Deck settings
        </button>
      </div>

      {cards.length > 0 ? (
        <div className="search">
          <input
            className="search__input"
            type="search"
            value={query}
            placeholder={`Search ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search cards"
          />
        </div>
      ) : null}

      <div className="cards" ref={list}>
        {cards.length === 0 ? (
          <div className="state">
            <p className="content">No cards yet.</p>
            <p className="label">Add one and it starts appearing in reviews straight away.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="rest">Nothing matches “{query.trim()}”.</p>
        ) : (
          <ul>
            {shown.map((card) => (
              <CardRow
                key={card.id}
                deck={deck}
                card={card}
                memories={byCard.get(card.id) ?? []}
                now={now}
                onOpen={() => navigate(`/deck/${deckId}/card/${card.id}`)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="dock">
        {due > 0 ? (
          <button className="action" onClick={start}>
            Review {due} {due === 1 ? 'side' : 'sides'}
          </button>
        ) : null}
        <button
          className={due > 0 ? 'action action--quiet add-deck' : 'action'}
          onClick={() => navigate(`/deck/${deckId}/card/new`)}
        >
          Add card
        </button>
      </div>
    </div>
  )
}

/**
 * Put a scrolling list back where it was. See DESIGN.md §6 — the `uiState`
 * record is the other half of "a reload returns to exactly the same state":
 * the session covers the review, this covers everything you were looking at.
 *
 * Restored once, after the rows exist; saved on scroll, throttled through a
 * frame so a flick does not write on every event.
 */
function useScrollMemory(key: string) {
  const ref = useRef<HTMLDivElement>(null)
  const restored = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        void db.ui.put({ key, value: el.scrollTop })
      })
    }

    void db.ui.get(key).then((row) => {
      if (!restored.current && typeof row?.value === 'number') el.scrollTop = row.value
      restored.current = true
      el.addEventListener('scroll', onScroll, { passive: true })
    })

    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
    }
  }, [key])

  return ref
}

function CardRow({
  deck,
  card,
  memories,
  now,
  onOpen,
}: {
  deck: Deck
  card: Card
  /** Passed down rather than queried here: a deck of 500 cards should open one
      live query, not 500. */
  memories: Memory[]
  now: number
  onOpen: () => void
}) {
  const byId = new Map(memories.map((m) => [m.sideId, m]))
  const filled = card.sides.filter(sideFilled)
  const first = filled[0]

  return (
    <li>
      <button className="card-row" onClick={onOpen}>
        <span className="card-row__text">
          {first?.kind === 'image' ? '(image)' : (first?.value ?? '(empty)')}
        </span>
        <span className="card-row__ramps">
          {filled.filter((s) => sideTested(deck, s)).map((s) => (
            <Ramp
              key={s.id}
              step={memoryRamp(byId.get(s.id), now)}
              label={sideLabel(deck, s)}
            />
          ))}
        </span>
      </button>
    </li>
  )
}
