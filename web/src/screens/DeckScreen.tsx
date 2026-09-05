/**
 * One deck: its cards, and the way in to editing them. See DESIGN.md §4.
 *
 * Each card row shows its sides as ramp marks, so which cards are decaying is
 * visible without opening anything.
 */
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { type Card, type Deck, sideFilled, sideLabel, sideTested } from '@eidet/shared'
import { db } from '../db/db.ts'
import { startSession } from '../session/session.ts'
import { Ramp, memoryRamp } from '../ui/Ramp.tsx'

export function DeckScreen() {
  const { deckId = '' } = useParams()
  const navigate = useNavigate()
  const now = Date.now()

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

      <div className="cards">
        {cards.length === 0 ? (
          <div className="stage">
            <p className="content">No cards yet.</p>
            <p className="label">Add one and it starts appearing in reviews straight away.</p>
          </div>
        ) : (
          <ul>
            {cards.map((card) => (
              <CardRow
                key={card.id}
                deck={deck}
                card={card}
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

function CardRow({
  deck,
  card,
  now,
  onOpen,
}: {
  deck: Deck
  card: Card
  now: number
  onOpen: () => void
}) {
  const memories = useLiveQuery(() => db.memories.where('cardId').equals(card.id).toArray(), [card.id])
  const byId = new Map((memories ?? []).map((m) => [m.sideId, m]))
  const filled = card.sides.filter(sideFilled)
  const first = filled[0]

  return (
    <li>
      <button className="card-row" onClick={onOpen}>
        <span className="card-row__text content">
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
