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
  default_w,
  type Card as FsrsCard,
  type FSRS,
  type FSRSParameters,
} from 'ts-fsrs'

import {
  type CardId,
  type DeckId,
  type Grade,
  type Memory,
  type ParamSet,
  Rating,
  type Review,
  type ReviewId,
  type SideId,
} from './types.ts'

type SideIds = Pick<Memory, 'sideId' | 'cardId' | 'deckId'>

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
  /** Sub-day steps for a first encounter; the FSRS default is 1m then 10m. */
  learningSteps?: string[]
  /** Off for replay, which must be deterministic. */
  fuzz?: boolean
}

export function scheduler(options: SchedulerOptions = {}): FSRS {
  return fsrs({
    ...DEFAULT_PARAMS,
    w: options.w ?? [...default_w],
    request_retention: options.requestRetention ?? DEFAULT_PARAMS.request_retention,
    learning_steps: (options.learningSteps ??
      DEFAULT_PARAMS.learning_steps) as FSRSParameters['learning_steps'],
    enable_fuzz: options.fuzz ?? DEFAULT_PARAMS.enable_fuzz,
  })
}

/** A scheduler running under a stored parameter set. */
function schedulerFor(params: ParamSet, fuzz?: boolean): FSRS {
  return scheduler({
    w: params.w,
    requestRetention: params.requestRetention,
    learningSteps: params.learningSteps,
    ...(fuzz === undefined ? {} : { fuzz }),
  })
}

/**
 * The instance behind every read-only default argument. Built once:
 * `retrievability` is called per side on every render of the home screen and
 * the hero chart, and cue selection calls it per candidate side, so a fresh
 * FSRS per call adds up. It takes no options, so there is only ever one of it
 * to have.
 */
let readOnlyScheduler: FSRS | undefined

export function defaultScheduler(): FSRS {
  return (readOnlyScheduler ??= scheduler())
}

/**
 * A short, stable content hash of the weights in force, stored on each review so
 * the log records which parameters produced it.
 */
export function paramsHash(w: number[], requestRetention: number, learningSteps: string[]): string {
  const text = `${requestRetention}|${learningSteps.join(',')}|${w.map((n) => n.toFixed(6)).join(',')}`
  // FNV-1a, 32-bit. Not cryptographic — this identifies a parameter set, and the
  // full weights live in `paramSets` keyed by this value.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function paramSet(
  w: number[],
  requestRetention: number,
  learningSteps: string[],
  now: number,
): ParamSet {
  return {
    hash: paramsHash(w, requestRetention, learningSteps),
    w,
    requestRetention,
    learningSteps,
    createdAt: now,
  }
}

export function defaultParamSet(now: number): ParamSet {
  return paramSet(
    [...default_w],
    DEFAULT_PARAMS.request_retention,
    [...DEFAULT_PARAMS.learning_steps],
    now,
  )
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
  }
}

function fromFsrsCard(c: FsrsCard, ids: SideIds): Memory {
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
    state: c.state,
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

function idsOf(m: Memory): SideIds {
  return { sideId: m.sideId, cardId: m.cardId, deckId: m.deckId }
}

/**
 * Current probability of recall, 0–1. Drives cue selection (§1) and is the value
 * the whole interface visualises (§3) — the ramp is this number.
 */
export function retrievability(m: Memory, now: number, fsrsInstance = defaultScheduler()): number {
  if (m.lastReview === null) return 0
  return fsrsInstance.get_retrievability(toFsrsCard(m), new Date(now), false)
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
  const { card } = schedulerFor(params, fuzz).next(toFsrsCard(memory), new Date(now), rating)
  const after = fromFsrsCard(card, idsOf(memory))
  return {
    memory: after,
    review: reviewRow({ reviewId, memory, after, rating, cueSideId, now, params }),
  }
}

/**
 * Start one side over, as a review. Recorded in the append-only log rather than
 * written straight to the memory so that it syncs like any other review, and
 * so a replay (which folds the log) keeps it instead of quietly undoing it.
 */
export function resetReview(args: {
  reviewId: ReviewId
  memory: Memory
  now: number
  params: ParamSet
}): GradeResult {
  const { reviewId, memory, now, params } = args
  const after = newMemory(idsOf(memory), now)
  return {
    memory: after,
    review: reviewRow({
      reviewId,
      memory,
      after,
      rating: Rating.Reset,
      cueSideId: null,
      now,
      params,
    }),
  }
}

function reviewRow(args: {
  reviewId: ReviewId
  memory: Memory
  after: Memory
  rating: Rating
  cueSideId: SideId | null
  now: number
  params: ParamSet
}): Review {
  const { reviewId, memory, after, rating, cueSideId, now, params } = args
  return {
    id: reviewId,
    ...idsOf(memory),
    cueSideId,
    rating,
    reviewedAt: now,
    // A side that has never been reviewed has no "before" worth keeping: undo
    // takes a null here back to a fresh memory.
    memoryBefore: memory.lastReview === null && memory.reps === 0 ? null : memory,
    memoryAfter: after,
    paramsHash: params.hash,
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
  const s = schedulerFor(params, false)
  let memory = newMemory(ids, first ? first.reviewedAt : Date.now())
  for (const r of ordered) {
    if (r.rating === Rating.Reset) {
      memory = newMemory(ids, r.reviewedAt)
      continue
    }
    const { card } = s.next(toFsrsCard(memory), new Date(r.reviewedAt), r.rating)
    memory = fromFsrsCard(card, ids)
  }
  return memory
}
