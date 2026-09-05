import { describe, expect, it } from 'vitest'
import {
  defaultParamSet,
  grade,
  newMemory,
  paramSet,
  paramsHash,
  replay,
  retrievability,
} from '../src/schedule.ts'
import { Grade, type Memory, type Review } from '../src/types.ts'
import { DAY, T0 } from './factory.ts'

const IDS = { sideId: 's1', cardId: 'c1', deckId: 'd1' }
const PARAMS = defaultParamSet(T0)

describe('grading one side', () => {
  it('schedules further out for Easy than for Again', () => {
    const m = newMemory(IDS, T0)
    const again = grade({ reviewId: 'r', memory: m, rating: Grade.Again, cueSideId: 'c', now: T0, params: PARAMS })
    const easy = grade({ reviewId: 'r', memory: m, rating: Grade.Easy, cueSideId: 'c', now: T0, params: PARAMS })
    expect(easy.memory.due).toBeGreaterThan(again.memory.due)
    expect(easy.memory.stability).toBeGreaterThan(again.memory.stability)
  })

  it('records the cue that prompted the recall', () => {
    const r = grade({
      reviewId: 'r1',
      memory: newMemory(IDS, T0),
      rating: Grade.Good,
      cueSideId: 'glyph-side',
      now: T0,
      params: PARAMS,
    })
    expect(r.review.cueSideId).toBe('glyph-side')
    expect(r.review.reviewedAt).toBe(T0)
    expect(r.review.paramsHash).toBe(PARAMS.hash)
  })

  it('carries the resulting memory on the review, so state is an O(1) read', () => {
    const r = grade({ reviewId: 'r1', memory: newMemory(IDS, T0), rating: Grade.Good, cueSideId: null, now: T0, params: PARAMS })
    expect(r.review.memoryAfter).toEqual(r.memory)
    // A side's very first review has no prior state to record.
    expect(r.review.memoryBefore).toBeNull()
  })

  it('counts a lapse when a learned side is forgotten', () => {
    let m = newMemory(IDS, T0)
    for (const [i, at] of [T0, T0 + DAY, T0 + 5 * DAY].entries()) {
      m = grade({ reviewId: `r${i}`, memory: m, rating: Grade.Good, cueSideId: null, now: at, params: PARAMS }).memory
    }
    const before = m.lapses
    const after = grade({ reviewId: 'rx', memory: m, rating: Grade.Again, cueSideId: null, now: T0 + 40 * DAY, params: PARAMS }).memory
    expect(after.lapses).toBe(before + 1)
  })

  it('is pure — grading twice from the same state gives the same schedule', () => {
    const m = newMemory(IDS, T0)
    const a = grade({ reviewId: 'r', memory: m, rating: Grade.Good, cueSideId: null, now: T0, params: PARAMS })
    const b = grade({ reviewId: 'r', memory: m, rating: Grade.Good, cueSideId: null, now: T0, params: PARAMS })
    expect(a.memory).toEqual(b.memory)
    expect(m.reps).toBe(0) // the input was not mutated
  })
})

describe('grade fan-out across a reveal', () => {
  /**
   * The interaction from §1 step 5: one press applies to every unmissed row,
   * and rows the user tapped always take Again.
   */
  function applyReveal(targets: Memory[], missed: Set<string>, pressed: 1 | 2 | 3 | 4, now: number) {
    return targets.map((m, i) =>
      grade({
        reviewId: `r${i}`,
        memory: m,
        rating: missed.has(m.sideId) ? Grade.Again : pressed,
        cueSideId: 'cue',
        now,
        params: PARAMS,
      }),
    )
  }

  it('writes Again for missed rows and the pressed grade for the rest', () => {
    const targets = ['a', 'b', 'c', 'd'].map((id) => newMemory({ ...IDS, sideId: id }, T0))
    const out = applyReveal(targets, new Set(['b', 'd']), Grade.Good, T0)
    expect(out.map((r) => r.review.rating)).toEqual([Grade.Good, Grade.Again, Grade.Good, Grade.Again])
  })

  it('gives every row Again when Again is pressed, missed or not', () => {
    const targets = ['a', 'b'].map((id) => newMemory({ ...IDS, sideId: id }, T0))
    const out = applyReveal(targets, new Set(['a']), Grade.Again, T0)
    expect(out.map((r) => r.review.rating)).toEqual([Grade.Again, Grade.Again])
  })

  it('schedules each side of one card independently', () => {
    const targets = ['a', 'b'].map((id) => newMemory({ ...IDS, sideId: id }, T0))
    const out = applyReveal(targets, new Set(['b']), Grade.Easy, T0)
    expect(out[0]!.memory.due).toBeGreaterThan(out[1]!.memory.due)
    expect(out[0]!.memory.sideId).toBe('a')
    expect(out[1]!.memory.sideId).toBe('b')
  })
})

describe('replay', () => {
  /** Build a history one grade at a time, with fuzz off so it is reproducible. */
  function history(ratings: (1 | 2 | 3 | 4)[]) {
    const reviews: Review[] = []
    let m = newMemory(IDS, T0)
    let at = T0
    for (const [i, rating] of ratings.entries()) {
      at = Math.max(m.due, at + DAY)
      const next = grade({ reviewId: `r${i}`, memory: m, rating, cueSideId: 'cue', now: at, params: PARAMS, fuzz: false })
      reviews.push(next.review)
      m = next.memory
    }
    return { reviews, memory: m }
  }

  it('reproduces a fold over the log exactly when fuzz is off', () => {
    const { reviews, memory } = history([Grade.Good, Grade.Again, Grade.Hard, Grade.Good, Grade.Easy, Grade.Good])
    expect(replay(IDS, reviews, PARAMS)).toEqual(memory)
  })

  it('sorts an out-of-order log before folding it', () => {
    const { reviews, memory } = history([Grade.Good, Grade.Good, Grade.Good])
    const shuffled = [reviews[2]!, reviews[0]!, reviews[1]!]
    expect(replay(IDS, shuffled, PARAMS)).toEqual(memory)
  })

  it('does not reproduce `due` under fuzz — which is why memoryAfter is stored', () => {
    // The design decision in §2, asserted rather than assumed: with fuzz on, a
    // fold over the log recovers the memory state but not the exact interval,
    // so `memoryAfter` on the review is authoritative for scheduling.
    const reviews: Review[] = []
    let m = newMemory(IDS, T0)
    let at = T0
    for (const [i, rating] of [Grade.Good, Grade.Good, Grade.Good, Grade.Good].entries()) {
      at = Math.max(m.due, at + DAY)
      const next = grade({ reviewId: `r${i}`, memory: m, rating, cueSideId: null, now: at, params: PARAMS, fuzz: true })
      reviews.push(next.review)
      m = next.memory
    }
    const folded = replay(IDS, reviews, PARAMS)
    expect(folded.stability).toBeCloseTo(m.stability, 6)
    expect(folded.difficulty).toBeCloseTo(m.difficulty, 6)
    expect(folded.reps).toBe(m.reps)
    expect(folded.lapses).toBe(m.lapses)
    // `due` is the part that may drift, and the stored snapshot is the truth.
    expect(reviews.at(-1)!.memoryAfter.due).toBe(m.due)
  })

  it('returns a fresh memory for a side with no reviews', () => {
    const m = replay(IDS, [], PARAMS)
    expect(m.reps).toBe(0)
    expect(m.lastReview).toBeNull()
  })
})

describe('parameter identity', () => {
  const STEPS = ['1m', '10m']

  it('hashes the same weights to the same value', () => {
    const w = Array.from({ length: 21 }, (_, i) => i / 7)
    expect(paramsHash(w, 0.9, STEPS)).toBe(paramsHash([...w], 0.9, [...STEPS]))
    expect(paramsHash(w, 0.9, STEPS)).not.toBe(paramsHash(w, 0.85, STEPS))
    expect(paramSet(w, 0.9, STEPS, T0).hash).toHaveLength(8)
  })

  it('distinguishes parameter sets that differ only in their learning steps', () => {
    const w = Array.from({ length: 21 }, (_, i) => i / 7)
    expect(paramsHash(w, 0.9, ['1m', '10m'])).not.toBe(paramsHash(w, 0.9, ['5m', '25m']))
  })

  it('defaults to the FSRS-6 weight vector', () => {
    expect(PARAMS.w).toHaveLength(21)
    expect(PARAMS.requestRetention).toBe(0.9)
    expect(PARAMS.learningSteps).toEqual(['1m', '10m'])
  })
})

describe('retrievability', () => {
  it('is 1 immediately after a review and decays from there', () => {
    const m = grade({ reviewId: 'r', memory: newMemory(IDS, T0), rating: Grade.Good, cueSideId: null, now: T0, params: PARAMS }).memory
    expect(retrievability(m, T0)).toBeCloseTo(1, 2)
    expect(retrievability(m, T0 + 365 * DAY)).toBeLessThan(0.5)
  })
})
