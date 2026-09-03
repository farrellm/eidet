/**
 * The FSRS-6 boundary. See DESIGN.md §2.
 *
 * Nothing outside this file imports `ts-fsrs`. Everything here is a pure
 * function over plain data, so the whole scheduling model is testable without a
 * browser, a clock, or a database.
 */
import {
  createEmptyCard,
  fsrs,
  generatorParameters,
  default_w,
  type Card as FsrsCard,
  type FSRS,
  type FSRSParameters,
  type Grade as FsrsGrade,
} from 'ts-fsrs'

import {
  type CardId,
  type DeckId,
  type Grade,
  type Memory,
  type MemoryState,
  type ParamSet,
  type Review,
  type ReviewId,
  type SideId,
} from './types.ts'

const DAY_MS = 86_400_000

/**
 * Defaults for a phone-first, single-user collection.
 *
 * `enable_fuzz` spreads load across days, which is worth having and is why
 * `memoryAfter` is stored on every review rather than recomputed (§2).
 * `enable_short_term` keeps the sub-day learning steps that make a first
 * encounter stick within one sitting.
 */
export const DEFAULT_PARAMS = {
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'] as FSRSParameters['learning_steps'],
  relearning_steps: ['10m'] as FSRSParameters['relearning_steps'],
} satisfies Partial<FSRSParameters>

export interface SchedulerOptions {
  /** Trained weights; falls back to the FSRS-6 defaults. */
  w?: number[]
  requestRetention?: number
  /** Off for replay, which must be deterministic. */
  fuzz?: boolean
}

export function scheduler(options: SchedulerOptions = {}): FSRS {
  return fsrs({
    ...DEFAULT_PARAMS,
    w: options.w ?? [...default_w],
    request_retention: options.requestRetention ?? DEFAULT_PARAMS.request_retention,
    enable_fuzz: options.fuzz ?? DEFAULT_PARAMS.enable_fuzz,
  })
}

/**
 * A short, stable content hash of the weights in force, stored on each review so
 * the log records which parameters produced it.
 */
export function paramsHash(w: number[], requestRetention: number): string {
  const text = `${requestRetention}|${w.map((n) => n.toFixed(6)).join(',')}`
  // FNV-1a, 32-bit. Not cryptographic — this identifies a parameter set, and the
  // full weights live in `paramSets` keyed by this value.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function paramSet(w: number[], requestRetention: number, now: number): ParamSet {
  return { hash: paramsHash(w, requestRetention), w, requestRetention, createdAt: now }
}

export function defaultParamSet(now: number): ParamSet {
  return paramSet([...default_w], DEFAULT_PARAMS.request_retention, now)
}

// ------------------------------------------------------- ts-fsrs conversion

function toFsrsCard(m: Memory): FsrsCard {
  return {
    due: new Date(m.due),
    stability: m.stability,
    difficulty: m.difficulty,
    elapsed_days: m.elapsedDays,
    scheduled_days: m.scheduledDays,
    learning_steps: m.learningSteps,
    reps: m.reps,
    lapses: m.lapses,
    state: m.state,
    ...(m.lastReview === null ? {} : { last_review: new Date(m.lastReview) }),
  } as FsrsCard
}

function fromFsrsCard(c: FsrsCard, ids: Pick<Memory, 'sideId' | 'cardId' | 'deckId'>): Memory {
  return {
    ...ids,
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as MemoryState,
    lastReview: c.last_review ? c.last_review.getTime() : null,
  }
}

// ------------------------------------------------------------------ public

/** A side that has never been reviewed: due immediately, no history. */
export function newMemory(
  ids: { sideId: SideId; cardId: CardId; deckId: DeckId },
  now: number,
): Memory {
  return fromFsrsCard(createEmptyCard(new Date(now)), ids)
}

/**
 * Current probability of recall, 0–1. Drives cue selection (§1) and is the value
 * the whole interface visualises (§3) — the ramp is this number.
 */
export function retrievability(m: Memory, now: number, fsrsInstance = scheduler()): number {
  if (m.lastReview === null) return 0
  return fsrsInstance.get_retrievability(toFsrsCard(m), new Date(now), false)
}

/** How overdue a side is, in days. Negative means not yet due. */
export function overdueDays(m: Memory, now: number): number {
  return (now - m.due) / DAY_MS
}

export interface GradeResult {
  memory: Memory
  review: Review
}

/**
 * Apply one grade to one side. Pure: the caller supplies the id, the clock and
 * the parameters, and persists both halves of the result together.
 */
export function grade(args: {
  reviewId: ReviewId
  memory: Memory
  rating: Grade
  cueSideId: SideId | null
  now: number
  params: ParamSet
  /** Off for replay and for tests that need an exact schedule. */
  fuzz?: boolean
}): GradeResult {
  const { reviewId, memory, rating, cueSideId, now, params, fuzz } = args
  const s = scheduler({
    w: params.w,
    requestRetention: params.requestRetention,
    ...(fuzz === undefined ? {} : { fuzz }),
  })
  const { card } = s.next(toFsrsCard(memory), new Date(now), rating as FsrsGrade)
  const after = fromFsrsCard(card, {
    sideId: memory.sideId,
    cardId: memory.cardId,
    deckId: memory.deckId,
  })
  return {
    memory: after,
    review: {
      id: reviewId,
      sideId: memory.sideId,
      cardId: memory.cardId,
      deckId: memory.deckId,
      cueSideId,
      rating,
      reviewedAt: now,
      memoryBefore: memory.lastReview === null && memory.reps === 0 ? null : memory,
      memoryAfter: after,
      paramsHash: params.hash,
    },
  }
}

/**
 * Rebuild a side's memory from its review log. Only used when parameters change
 * — normal reads take `memoryAfter` off the newest review, because fuzz makes
 * this fold non-deterministic unless it is disabled, as it is here.
 */
export function replay(
  ids: { sideId: SideId; cardId: CardId; deckId: DeckId },
  reviews: Review[],
  params: ParamSet,
): Memory {
  const ordered = [...reviews].sort((a, b) => a.reviewedAt - b.reviewedAt)
  const first = ordered[0]
  const s = scheduler({ w: params.w, requestRetention: params.requestRetention, fuzz: false })
  let memory = newMemory(ids, first ? first.reviewedAt : Date.now())
  for (const r of ordered) {
    const { card } = s.next(toFsrsCard(memory), new Date(r.reviewedAt), r.rating as FsrsGrade)
    memory = fromFsrsCard(card, ids)
  }
  return memory
}
