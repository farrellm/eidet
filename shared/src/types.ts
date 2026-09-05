/**
 * Core domain types. See DESIGN.md §5 (data model) and §6 (sync).
 *
 * Timestamps are epoch milliseconds throughout, never `Date`. They cross an
 * IndexedDB index, a SQLite column and a JSON wire without a conversion step,
 * and they sort. Conversion to `Date` happens only at the ts-fsrs boundary in
 * `schedule.ts`.
 */

export type DeckId = string
export type CardId = string
export type SideId = string
export type FieldId = string
export type ReviewId = string
export type SessionId = string
/** Lowercase hex SHA-256 of a blob's bytes. */
export type Sha256 = string

export type SideKind = 'text' | 'image'

/** FSRS card states, mirroring `State` in ts-fsrs. A const object rather than an
 * enum: `isolatedModules` forbids `const enum`, and these cross the wire as ints. */
export type MemoryState = 0 | 1 | 2 | 3
export const MemoryState = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const satisfies Record<string, MemoryState>

/** FSRS grades, mirroring `Rating` in ts-fsrs. `Manual` (0) is not used here. */
export type Grade = 1 | 2 | 3 | 4
export const Grade = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
} as const satisfies Record<string, Grade>

// ---------------------------------------------------------------- decks

/**
 * A field in a `schema` deck. `tested` and `name` live here rather than on each
 * side so renaming a field, or turning testing off for it, is one write and
 * takes effect across every card in the deck.
 */
export interface DeckField {
  id: FieldId
  name: string
  kind: SideKind
  tested: boolean
}

/**
 * `schema` decks declare their fields up front and every card has a slot per
 * field. `freeform` decks let each card carry its own labelled sides. The mode
 * is a property of the deck so the editor always knows which shape it is in;
 * everything downstream sees the same `Side` rows either way.
 */
export type DeckMode = 'schema' | 'freeform'

export interface Deck {
  id: DeckId
  name: string
  mode: DeckMode
  /** Empty for `freeform` decks. */
  fields: DeckField[]
  /** Pin a prompt direction, or let cue selection pick by retrievability. */
  cuePreference: FieldId | 'auto'
  order: number
  updatedAt: number
  deletedAt: number | null
  /** Server-assigned sync sequence; 0 while the row has never been pushed. */
  seq: number
}

// ---------------------------------------------------------------- cards

/**
 * One face of a card. In a `schema` deck `fieldId` points at the deck field and
 * `label`/`tested` are read from it; in a `freeform` deck `fieldId` is null and
 * the side carries its own. Use `sideLabel`/`sideTested` rather than reading
 * either pair directly.
 */
export interface Side {
  id: SideId
  fieldId: FieldId | null
  /** Freeform decks only; null in schema decks. */
  label: string | null
  kind: SideKind
  /** Text content, or a `Sha256` when `kind === 'image'`. */
  value: string
  /** Freeform decks only; null in schema decks. */
  tested: boolean | null
}

export interface Card {
  id: CardId
  deckId: DeckId
  /** Sides are stored whole on the card: they are always read and edited whole. */
  sides: Side[]
  updatedAt: number
  deletedAt: number | null
  seq: number
}

// ---------------------------------------------------------------- memory

/**
 * One side's FSRS state — the scheduling unit. Derived data: always equal to the
 * `memoryAfter` of the newest review for the side. Materialised so the due queue
 * is one indexed range scan on `due`, never authoritative.
 */
export interface Memory {
  sideId: SideId
  cardId: CardId
  deckId: DeckId
  due: number
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: MemoryState
  lastReview: number | null
}

/**
 * Append-only and immutable. This is what makes sync nearly conflict-free (§6)
 * and what feeds the parameter optimiser. `memoryAfter` is stored rather than
 * recomputed because fuzz makes a fold over the log non-deterministic.
 */
export interface Review {
  id: ReviewId
  sideId: SideId
  cardId: CardId
  deckId: DeckId
  /** Which side prompted this recall; null for a schedule reset. */
  cueSideId: SideId | null
  rating: Grade
  reviewedAt: number
  memoryBefore: Memory | null
  memoryAfter: Memory
  /** Identifies the weights in force, via `paramSets`. */
  paramsHash: string
}

/** The FSRS weights a set of reviews was produced under, keyed by content hash. */
export interface ParamSet {
  hash: string
  w: number[]
  requestRetention: number
  /** Sub-day steps for a side's first encounter, e.g. `['1m', '10m']`. */
  learningSteps: string[]
  createdAt: number
}

// ---------------------------------------------------------------- blobs

export interface BlobMeta {
  sha256: Sha256
  mime: string
  bytes: number
  width: number
  height: number
  createdAt: number
}

// ---------------------------------------------------------------- session

/**
 * One card's turn in a session: a cue and the sides to be recalled from it.
 * All of a card's due sides are batched into a single reveal, which is also
 * what makes the sight cooldown structural — a side cannot be both the cue and
 * a target, and a card appears in the queue exactly once.
 */
export interface CardBatch {
  cardId: CardId
  deckId: DeckId
  cueSideId: SideId
  /** Due, tested sides to recall. Never contains `cueSideId`. */
  targetSideIds: SideId[]
  /** Non-due sides shown as context; gradeable only if marked missed. */
  contextSideIds: SideId[]
}

/**
 * Persisted on every state transition so a reload lands on the identical screen
 * (§6). Graded sides are already rows in `reviews`, so nothing is re-asked.
 */
export interface ReviewSession {
  id: SessionId
  /** Empty means every deck. */
  deckIds: DeckId[]
  queue: CardBatch[]
  index: number
  phase: 'cue' | 'revealed'
  /** Sides the user tapped to mark missed in the current reveal. */
  missedSideIds: SideId[]
  startedAt: number
  gradedCount: number
  /**
   * What the previous grade press wrote, so it can be taken back. Undo is
   * offered only while these reviews are still unsent: reviews are append-only
   * and immutable once they reach the server, which is the single property
   * that makes sync conflict-free (§5, §6).
   */
  lastCommit: LastCommit | null
}

export interface LastCommit {
  reviewIds: ReviewId[]
  /** Restored along with the reveal, so the screen comes back as it was. */
  missedSideIds: SideId[]
}

// ---------------------------------------------------------------- sync

export interface ChangeSet {
  decks: Deck[]
  cards: Card[]
  reviews: Review[]
  paramSets: ParamSet[]
}

export interface PullResponse extends ChangeSet {
  seq: number
  blobs: BlobMeta[]
}

export interface PushResponse {
  seq: number
}

// ---------------------------------------------------------------- resolvers

/** The display label for a side, resolved against its deck. */
export function sideLabel(deck: Deck, side: Side): string {
  if (deck.mode === 'freeform') return side.label ?? ''
  return deck.fields.find((f) => f.id === side.fieldId)?.name ?? ''
}

/** Whether a side is scheduled and graded, resolved against its deck. */
export function sideTested(deck: Deck, side: Side): boolean {
  if (deck.mode === 'freeform') return side.tested ?? false
  return deck.fields.find((f) => f.id === side.fieldId)?.tested ?? false
}

/** A side with no content holds no schedule and is never shown. */
export function sideFilled(side: Side): boolean {
  return side.value.trim().length > 0
}
