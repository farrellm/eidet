/**
 * Review sessions. See DESIGN.md §6 ("Reload returns to exactly the same state").
 *
 * The session record is written on every state transition and the session id
 * lives in the URL, so a reload restores the queue, the position, the phase and
 * the missed toggles. Graded sides are already rows in `reviews`, so nothing is
 * ever re-asked.
 *
 * The queue is built once, up front. That is what makes the sight cooldown
 * structural: a card appears exactly once, all its due sides land in a single
 * reveal, and a side can never be shown as a cue and then asked as a target.
 */
import {
  type CardBatch,
  type DeckId,
  type Grade,
  type ReviewSession,
  type SessionId,
  type SideId,
  buildQueue,
} from '@eidet/shared'
import { db } from '../db/db.ts'
import { commitReveal, newId } from '../db/mutations.ts'

export async function startSession(
  deckIds: DeckId[] = [],
  now = Date.now(),
): Promise<ReviewSession | null> {
  const [decks, cards, memories] = await Promise.all([
    db.decks.toArray(),
    db.cards.toArray(),
    db.memories.toArray(),
  ])
  const queue = buildQueue({
    decks,
    cards,
    memories: new Map(memories.map((m) => [m.sideId, m])),
    now,
    deckIds,
  })
  if (queue.length === 0) return null

  const session: ReviewSession = {
    id: newId(),
    deckIds,
    queue,
    index: 0,
    phase: 'cue',
    missedSideIds: [],
    startedAt: now,
    gradedCount: 0,
  }
  await db.sessions.put(session)
  return session
}

export async function loadSession(id: SessionId): Promise<ReviewSession | undefined> {
  return db.sessions.get(id)
}

async function write(session: ReviewSession): Promise<ReviewSession> {
  await db.sessions.put(session)
  return session
}

export function currentBatch(session: ReviewSession): CardBatch | undefined {
  return session.queue[session.index]
}

export function isFinished(session: ReviewSession): boolean {
  return session.index >= session.queue.length
}

export async function reveal(session: ReviewSession): Promise<ReviewSession> {
  return write({ ...session, phase: 'revealed' })
}

/**
 * Toggle a side as missed. Works on context sides too: marking a side you were
 * not asked about records an `Again` for it, which is how "must remember all
 * other sides" stays honest without forcing a grade on everything (§1 step 5).
 */
export async function toggleMissed(
  session: ReviewSession,
  sideId: SideId,
): Promise<ReviewSession> {
  const missed = session.missedSideIds.includes(sideId)
    ? session.missedSideIds.filter((id) => id !== sideId)
    : [...session.missedSideIds, sideId]
  return write({ ...session, missedSideIds: missed })
}

/**
 * Which sides a press of `pressed` would grade, and how (§1 step 5).
 *
 * One press applies to every unmissed target; missed sides always take `Again`.
 * A context side is graded only if the user tapped it, and only ever `Again` —
 * it was not due, so a pass on it carries no information, but a miss does.
 */
export function plannedGrades(
  batch: CardBatch,
  missedSideIds: SideId[],
  pressed: Grade,
): { sideId: SideId; rating: Grade }[] {
  const missed = new Set(missedSideIds)
  const out = batch.targetSideIds.map((sideId) => ({
    sideId,
    rating: (missed.has(sideId) ? 1 : pressed) as Grade,
  }))
  for (const sideId of batch.contextSideIds) {
    if (missed.has(sideId)) out.push({ sideId, rating: 1 as Grade })
  }
  return out
}

/** Commit the current reveal and advance. */
export async function commit(
  session: ReviewSession,
  pressed: Grade,
  now = Date.now(),
): Promise<ReviewSession> {
  const batch = currentBatch(session)
  if (!batch) return session

  await commitReveal(
    { cueSideId: batch.cueSideId, grades: plannedGrades(batch, session.missedSideIds, pressed) },
    now,
  )

  return write({
    ...session,
    index: session.index + 1,
    phase: 'cue',
    missedSideIds: [],
    gradedCount: session.gradedCount + batch.targetSideIds.length,
  })
}

/** Drop finished sessions so the table does not grow without bound. */
export async function pruneSessions(keep = 3) {
  const all = await db.sessions.orderBy('startedAt').reverse().toArray()
  const stale = all.filter((s) => isFinished(s)).slice(keep)
  await db.sessions.bulkDelete(stale.map((s) => s.id))
}
