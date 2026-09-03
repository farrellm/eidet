/**
 * The review screen. See DESIGN.md §1 (the loop), §3 (motion), §4 (layout).
 *
 * The card does not flip — it unfolds. One side cues; a tap reveals every other
 * side at once, each with its own strength. Tap a row to mark it missed, then
 * one grade press covers the rest: zero extra taps for a card you knew.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  type Card,
  type CardBatch,
  type Deck,
  type Grade,
  type ReviewSession,
  type Side,
  type SideId,
  sideLabel,
} from '@eidet/shared'
import { db } from '../db/db.ts'
import { commit, currentBatch, isFinished, loadSession, reveal, toggleMissed } from '../session/session.ts'
import { Ramp, memoryRamp, rampWord } from '../ui/Ramp.tsx'
import { SideValue } from '../ui/SideValue.tsx'

const GRADES: { rating: Grade; label: string }[] = [
  { rating: 1, label: 'Again' },
  { rating: 2, label: 'Hard' },
  { rating: 3, label: 'Good' },
  { rating: 4, label: 'Easy' },
]

export function Review() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [missing, setMissing] = useState(false)

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

  const batch = session ? currentBatch(session) : undefined
  const card = useLiveQuery(() => (batch ? db.cards.get(batch.cardId) : undefined), [batch?.cardId])
  const deck = useLiveQuery(() => (batch ? db.decks.get(batch.deckId) : undefined), [batch?.deckId])

  if (missing) return <Gone onLeave={() => navigate('/')} />
  if (!session) return <div className="app" />
  if (isFinished(session)) return <Done session={session} onLeave={() => navigate('/')} />
  if (!batch || !card || !deck) return <div className="app" />

  const remaining = session.queue
    .slice(session.index)
    .reduce((n, b) => n + b.targetSideIds.length, 0)
  const progress = session.queue.length === 0 ? 0 : session.index / session.queue.length

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
      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress__done" style={{ width: `${progress * 100}%` }} />
      </div>

      {session.phase === 'cue' ? (
        <CuePhase
          deck={deck}
          card={card}
          batch={batch}
          onReveal={async () => setSession(await reveal(session))}
        />
      ) : (
        <RevealPhase
          deck={deck}
          card={card}
          batch={batch}
          missed={session.missedSideIds}
          onToggle={async (id) => setSession(await toggleMissed(session, id))}
          onGrade={async (rating) => setSession(await commit(session, rating))}
        />
      )}
    </div>
  )
}

function CuePhase({
  deck,
  card,
  batch,
  onReveal,
}: {
  deck: Deck
  card: Card
  batch: CardBatch
  onReveal: () => void
}) {
  const cue = card.sides.find((s) => s.id === batch.cueSideId)
  const hidden = batch.targetSideIds.length + batch.contextSideIds.length
  if (!cue) return null

  return (
    <>
      <div className="stage">
        <div className="cue">
          <SideValue side={cue} />
        </div>
        <p className="label stage__label">{sideLabel(deck, cue)}</p>
        <p className="fold">
          {hidden} {hidden === 1 ? 'side' : 'sides'} hidden
        </p>
      </div>
      <div className="dock">
        <button className="action" onClick={onReveal}>
          Reveal
        </button>
      </div>
    </>
  )
}

function RevealPhase({
  deck,
  card,
  batch,
  missed,
  onToggle,
  onGrade,
}: {
  deck: Deck
  card: Card
  batch: CardBatch
  missed: SideId[]
  onToggle: (id: SideId) => void
  onGrade: (rating: Grade) => void
}) {
  const cue = card.sides.find((s) => s.id === batch.cueSideId)
  const byId = new Map(card.sides.map((s) => [s.id, s]))
  const targets = batch.targetSideIds.map((id) => byId.get(id)).filter(Boolean) as Side[]
  const context = batch.contextSideIds.map((id) => byId.get(id)).filter(Boolean) as Side[]

  return (
    <>
      <div className="docked">
        <span className="docked__cue">{cue ? <SideValue side={cue} inline /> : null}</span>
        <span className="label">{cue ? sideLabel(deck, cue) : ''}</span>
      </div>

      <div className="reveal">
        {targets.map((side, i) => (
          <SideRow
            key={side.id}
            deck={deck}
            side={side}
            index={i}
            missed={missed.includes(side.id)}
            onToggle={() => onToggle(side.id)}
          />
        ))}
        {context.map((side, i) => (
          <SideRow
            key={side.id}
            deck={deck}
            side={side}
            index={targets.length + i}
            context
            missed={missed.includes(side.id)}
            onToggle={() => onToggle(side.id)}
          />
        ))}
      </div>

      <div className="dock grades">
        {GRADES.map((g) => (
          <button key={g.rating} className="grade" onClick={() => onGrade(g.rating)}>
            {g.label}
          </button>
        ))}
      </div>
    </>
  )
}

function SideRow({
  deck,
  side,
  index,
  missed,
  context = false,
  onToggle,
}: {
  deck: Deck
  side: Side
  index: number
  missed: boolean
  context?: boolean
  onToggle: () => void
}) {
  const now = Date.now()
  const memory = useLiveQuery(() => db.memories.get(side.id), [side.id])
  const step = memoryRamp(memory, now)

  return (
    <button
      type="button"
      className={`row${missed ? ' row--missed' : ''}${context ? ' row--context' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
      onClick={onToggle}
      aria-pressed={missed}
      aria-label={`${sideLabel(deck, side)}${missed ? ', missed' : ''}. Tap to mark ${missed ? 'known' : 'missed'}.`}
    >
      <span className="row__head">
        <span className="label">{sideLabel(deck, side)}</span>
        {context ? (
          <span className="label row__note">not due</span>
        ) : (
          <Ramp step={step} label={`recall ${rampWord(step)}`} />
        )}
      </span>
      <span className="content row__value">
        <SideValue side={side} />
      </span>
    </button>
  )
}

function Done({ session, onLeave }: { session: ReviewSession; onLeave: () => void }) {
  return (
    <div className="app">
      <div className="strip">
        <span className="strip__spacer" />
      </div>
      <div className="stage">
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
      <div className="stage">
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
