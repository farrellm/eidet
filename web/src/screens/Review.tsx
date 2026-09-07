/**
 * The review screen. See DESIGN.md §1 (the loop), §3 (motion), §4 (layout).
 *
 * One side cues; a tap reveals every other side at once, each with its own
 * strength. Tap a row to mark it missed, then one grade press covers the rest:
 * zero extra taps for a card you knew.
 *
 * `CueCard` sits outside the phase branch on purpose. It is the same element in
 * both phases, which is what lets the reveal dock it from the centre to the top
 * strip instead of cutting between two different elements (§3).
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  type Card,
  type CardBatch,
  type Deck,
  type Grade,
  type Memory,
  type ReviewSession,
  type Side,
  type SideId,
  queueSize,
} from '@eidet/shared'
import { db } from '../db/db.ts'
import {
  canUndo,
  commit,
  currentBatch,
  isFinished,
  loadSession,
  reveal,
  toggleMissed,
  undo,
} from '../session/session.ts'
import { useSyncStatus } from '../sync/SyncContext.tsx'
import { CueCard } from '../ui/CueCard.tsx'
import { GradeBar } from '../ui/GradeBar.tsx'
import { SideRow } from '../ui/SideRow.tsx'

export function Review() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [missing, setMissing] = useState(false)
  const [undoable, setUndoable] = useState(false)
  const { lastSyncedAt } = useSyncStatus()

  // Restore straight from IndexedDB: the session id is in the URL, so a reload
  // lands on the identical screen with the identical queue position (§6).
  useEffect(() => {
    let live = true
    loadSession(sessionId).then((s) => {
      if (!live) return
      if (s) setSession(s)
      else setMissing(true)
    })
    return () => {
      live = false
    }
  }, [sessionId])

  // Re-asked on every transition *and* after every sync: a push is what takes
  // undo away, so the affordance has to disappear when the push lands rather
  // than lingering until the next grade and failing under the thumb.
  useEffect(() => {
    let live = true
    if (!session) return
    canUndo(session).then((ok) => {
      if (live) setUndoable(ok)
    })
    return () => {
      live = false
    }
  }, [session, lastSyncedAt])

  const batch = session ? currentBatch(session) : undefined
  const card = useLiveQuery(() => (batch ? db.cards.get(batch.cardId) : undefined), [batch?.cardId])
  const deck = useLiveQuery(() => (batch ? db.decks.get(batch.deckId) : undefined), [batch?.deckId])
  // Fetched once for the whole card rather than once per row: a reveal of six
  // sides should not open six live queries.
  const memories = useLiveQuery(
    () => (batch ? db.memories.where('cardId').equals(batch.cardId).toArray() : []),
    [batch?.cardId],
  )

  if (missing) return <Gone onLeave={() => navigate('/')} />
  if (!session) return <div className="app" />
  if (isFinished(session)) return <Done session={session} onLeave={() => navigate('/')} />
  if (!batch || !card || !deck || !memories) return <div className="app" />

  const cue = card.sides.find((s) => s.id === batch.cueSideId)
  if (!cue) return <div className="app" />

  const remaining = queueSize(session.queue.slice(session.index))
  const progress = session.queue.length === 0 ? 0 : session.index / session.queue.length
  const revealed = session.phase === 'revealed'

  return (
    <div className="app">
      <div className="strip">
        <button className="strip__back" onClick={() => navigate('/')} aria-label="Leave review">
          ‹
        </button>
        <span>{deck.name}</span>
        <span className="strip__spacer" />
        <span className="strip__count">{remaining} left</span>
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress__done" style={{ width: `${progress * 100}%` }} />
      </div>

      <CueCard
        deck={deck}
        cue={cue}
        docked={revealed}
        hidden={batch.targetSideIds.length + batch.contextSideIds.length}
      />

      {revealed ? (
        <RevealPhase
          deck={deck}
          card={card}
          batch={batch}
          memories={memories}
          missed={session.missedSideIds}
          onToggle={async (id) => setSession(await toggleMissed(session, id))}
          onGrade={async (rating) => setSession(await commit(session, rating))}
        />
      ) : (
        <div className="dock">
          {undoable ? (
            <p className="undo">
              <button className="link" onClick={async () => setSession(await undo(session))}>
                Undo last grade
              </button>
            </p>
          ) : null}
          <button className="action" onClick={async () => setSession(await reveal(session))}>
            Reveal
          </button>
        </div>
      )}
    </div>
  )
}

function RevealPhase({
  deck,
  card,
  batch,
  memories,
  missed,
  onToggle,
  onGrade,
}: {
  deck: Deck
  card: Card
  batch: CardBatch
  memories: Memory[]
  missed: SideId[]
  onToggle: (id: SideId) => void
  onGrade: (rating: Grade) => void
}) {
  const byId = new Map(card.sides.map((s) => [s.id, s]))
  const memoryOf = new Map(memories.map((m) => [m.sideId, m]))
  const pick = (ids: SideId[]) => ids.map((id) => byId.get(id)).filter(Boolean) as Side[]
  const targets = pick(batch.targetSideIds)
  const context = pick(batch.contextSideIds)

  return (
    <>
      <div className="reveal">
        {[...targets, ...context].map((side, i) => (
          <SideRow
            key={side.id}
            deck={deck}
            side={side}
            memory={memoryOf.get(side.id)}
            index={i}
            context={i >= targets.length}
            missed={missed.includes(side.id)}
            onToggle={() => onToggle(side.id)}
          />
        ))}
      </div>
      <GradeBar onGrade={onGrade} />
    </>
  )
}

function Done({ session, onLeave }: { session: ReviewSession; onLeave: () => void }) {
  return (
    <div className="app">
      <div className="strip">
        <span className="strip__spacer" />
      </div>
      <div className="state">
        <p className="content">
          {session.gradedCount} {session.gradedCount === 1 ? 'side' : 'sides'} reviewed.
        </p>
        <p className="label">Saved on this phone.</p>
      </div>
      <div className="dock">
        <button className="action" onClick={onLeave}>
          Done
        </button>
      </div>
    </div>
  )
}

function Gone({ onLeave }: { onLeave: () => void }) {
  return (
    <div className="app">
      <div className="state">
        <p className="content">That session has finished.</p>
      </div>
      <div className="dock">
        <button className="action" onClick={onLeave}>
          Back to decks
        </button>
      </div>
    </div>
  )
}
