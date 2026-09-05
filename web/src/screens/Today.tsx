/**
 * Home. See DESIGN.md §4.
 *
 * The hero is the cyanometer strip: every side placed along the ramp, so you
 * see the shape of your memory rather than a count. One brass action; decks
 * below it. No streaks — the instrument reports, it does not cheer.
 */
import { useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Deck, Memory } from '@eidet/shared'
import { db } from '../db/db.ts'
import { startSession } from '../session/session.ts'
import { Ramp, memoryRamp, rampWord } from '../ui/Ramp.tsx'
import { Cyanometer } from '../ui/Cyanometer.tsx'
import { formatWhen } from '../ui/format.ts'
import { useSyncStatus } from '../sync/SyncContext.tsx'

export function Today() {
  const navigate = useNavigate()
  const now = Date.now()
  const { status, lastSyncedAt } = useSyncStatus()
  const decks = useLiveQuery(() => db.decks.filter((d) => d.deletedAt === null).sortBy('order'), [])
  const memories = useLiveQuery(() => db.memories.toArray(), [])

  if (!decks || !memories) return <div className="app" />

  const due = memories.filter((m) => m.due <= now)
  const nextDue = memories
    .filter((m) => m.due > now)
    .reduce<number | null>((soonest, m) => (soonest === null || m.due < soonest ? m.due : soonest), null)

  const start = async () => {
    const session = await startSession([], Date.now())
    if (session) navigate(`/review/${session.id}`)
  }

  return (
    <div className="app">
      <div className="strip">
        <span className="wordmark">eidet</span>
        <span className="strip__spacer" />
        <span className="sync">
          {status === 'offline'
            ? 'Saved here'
            : lastSyncedAt
              ? `Synced ${formatWhen(lastSyncedAt, now)}`
              : 'Syncing'}
        </span>
      </div>

      <div className="today">
        {memories.length > 0 ? (
          <section className="today__hero">
            <Cyanometer memories={memories} now={now} />
          </section>
        ) : null}

        {decks.length === 0 ? (
          <Empty onAdd={() => navigate('/deck/new')} />
        ) : (
          <ul className="decks">
            {decks.map((deck) => (
              <DeckRow key={deck.id} deck={deck} memories={memories} now={now} />
            ))}
          </ul>
        )}
      </div>

      {/* With no decks the empty state carries its own invitation; a second
          dock underneath it would just be stranded furniture. */}
      {decks.length > 0 ? (
        <div className="dock">
          {due.length > 0 ? (
            <button className="action" onClick={start}>
              Review {due.length} {due.length === 1 ? 'side' : 'sides'}
            </button>
          ) : (
            <p className="rest">
              {memories.length === 0
                ? 'Nothing to review yet.'
                : nextDue === null
                  ? 'Nothing due.'
                  : `Nothing due. Next batch ${formatWhen(nextDue, now)}.`}
            </p>
          )}
          <button className="action action--quiet add-deck" onClick={() => navigate('/deck/new')}>
            Add deck
          </button>
        </div>
      ) : null}
    </div>
  )
}

function DeckRow({ deck, memories, now }: { deck: Deck; memories: Memory[]; now: number }) {
  const navigate = useNavigate()
  const mine = memories.filter((m) => m.deckId === deck.id)
  const due = mine.filter((m) => m.due <= now).length
  const ahead = mine.filter((m) => m.due > now)

  // The deck's typical strength, as one mark. Per-deck shape without a second
  // bar chart arguing with the hero.
  const steps = ahead.map((m) => memoryRamp(m, now)).sort((a, b) => a - b)
  const median = steps.length > 0 ? steps[Math.floor(steps.length / 2)]! : 0

  return (
    <li>
      <button className="deck" onClick={() => navigate(`/deck/${deck.id}`)}>
        <span className="deck__name">{deck.name}</span>
        <span className="deck__meta">
          {ahead.length > 0 ? <Ramp step={median} label={`typically ${rampWord(median)}`} /> : null}
          <span className={due > 0 ? 'num deck__due' : 'num deck__due deck__due--none'}>
            {due > 0 ? `${due} due` : `${mine.length} sides`}
          </span>
        </span>
      </button>
    </li>
  )
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="stage">
      <p className="content">No decks yet.</p>
      <p className="label">A deck is a set of cards that share the same shape.</p>
      <button className="action" onClick={onAdd}>
        Add deck
      </button>
    </div>
  )
}
