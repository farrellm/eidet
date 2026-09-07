# eidet — Design Document

## Context

`eidet` (from *eidetic*; Greek *eidos*, "that which is seen") is an empty repo with a one-line README: *A spaced memory repetition SPA.* This plan is the design document for building it.

It is a personal instrument, not a product: one user, no accounts, reached from an iPhone over Tailscale. Four constraints shape everything:

1. **Cards have N sides, not two.** One side cues; all the others are revealed and must be recalled.
2. **Each side carries its own memory state** and is scheduled independently — but all sides of a card are stored and edited as one thing.
3. **It must work with no internet at all**, and still persist to the server when the server is reachable.
4. **Reloading returns to exactly the same state** — mid-session, mid-reveal, mid-edit.

Constraint 3 is the architectural fulcrum. It means the phone holds the whole corpus and runs the scheduler itself; the server stores and syncs but never schedules. Constraints 1 and 2 mean the review unit is a *side*, not a card — which is what makes this app structurally different from every front/back flashcard app, and it drives the interface.

Existing work in `~/workspace` sets the conventions: **AisleFlow** is the closest sibling (household-scale, no auth, offline PWA, `tailscale serve`, systemd user unit, `DESIGN.md` as the authoritative doc that code comments cite). eidet follows those conventions but **not** AisleFlow's data layer — see §6.

---

## 1. Product shape

### Scheduling unit: the side

Each **testable side** owns one FSRS memory state. A side's state answers: *how well do I recall this side, cued by some other side of its card?* N sides → N states, never N×(N−1) directed pairs. That keeps the queue small and matches the brief exactly.

Not every side should be tested. A mnemonic, a source note, an example sentence — these are revealed as context but never graded and hold no memory state. So each side carries `tested: boolean`.

### The review loop

For a session over one or more decks:

1. **Build the queue.** Collect all testable sides with `due <= now`. Group by card. Order card-batches by the most-overdue side in each, with a light interleave so consecutive batches aren't from the same deck.
2. **Pick the cue.** For card X with due target set T, the cue is the side of X *not* in T with the highest current retrievability — the best-known side makes the best prompt. If every side is due, lift the highest-retrievability side out of T to serve as cue and leave it due.
3. **Sight cooldown.** A side shown as a cue is excluded from the target set for the rest of the session, so you're never asked to recall something you were shown ten seconds ago.
4. **Reveal.** One tap reveals *all* other sides at once — due ones as gradeable rows, the rest dimmed as context.
5. **Grade.** Tap any row to mark it missed. Then one press of `Again / Hard / Good / Easy` applies to every unmissed row; missed rows always take `Again`. **Common case: zero extra taps for a whole multi-side card.** Marking a *not-due* side missed records an `Again` for it too, pulling it back into rotation — that is how "must remember all other sides" stays honest without forcing grades on everything.

A deck may pin a preferred cue field (`cuePreference: fieldId | 'auto'`) for decks with an obvious prompt direction.

### Deck field model

Per the answer: **deck-defined fields by default, with a free-form mode per deck.** The mode is a property of the deck, so the editor always knows its shape.

```
Deck { mode: 'schema', fields: [{id, name, tested, kind: 'text'|'image'}] }
  → every card has one slot per field; a blank slot is no side and gets no schedule

Deck { mode: 'freeform' }
  → each card carries its own [{label, tested, kind, value}] list
```

Both compile down to the same `sides` rows at rest, so the scheduler, review loop, and sync see one shape. Only the editor branches.

### Scope boundaries

In: decks, N-sided cards, text and image sides, per-side FSRS-6 scheduling, offline review, server sync, session restore.
Out (for now): sharing, multi-user, auth, audio sides, cloze deletion, deck import/export, parameter optimisation (§9 phase 4).

---

## 2. Algorithm — FSRS-6 via `ts-fsrs`

State of the art is **FSRS-6**, shipped late 2025, trained on ~700M reviews. Use **`ts-fsrs` ≥ 5.4.1**, which implements it (21 weights, `w0`–`w20`).

```ts
import { fsrs, createEmptyCard, Rating, forgetting_curve } from 'ts-fsrs'

const scheduler = fsrs({
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_fuzz: true,
  enable_short_term: true,
  learning_steps: ['1m', '10m'],
  relearning_steps: ['10m'],
})

const { card, log } = scheduler.next(prevMemory, now, Rating.Good)
```

Three parts of the API carry weight here:

- **`scheduler.next(memory, at, rating)` is pure** and returns `{card, log}`. Both are plain serialisable structs. This is what lets the review log be the source of truth.
- **`forgetting_curve(decay, elapsedDays, stability)` → R ∈ (0,1]** is a continuous per-side retrievability. This is not just internal bookkeeping — it drives cue selection (§1) *and* it is the app's central visualisation (§4).
- **`scheduler.rollback(card, log)`** backs out a review. In the end undo does not use it: the review row already carries the exact `memoryBefore` it replaced, so restoring is a `put` (§11).

**Fuzz vs. replay.** `enable_fuzz: true` spreads load across days but makes a fold over the log non-deterministic. Resolve it by **storing the resulting memory snapshot on the review row**: current state is "the snapshot on the newest review for this side", an O(1) read. Full replay from `createEmptyCard()` is a separate, deliberate operation, run only when parameters change.

---

## 3. Visual design — "Cyanometer"

Named for de Saussure's 1789 cyanometer: a ring of 53 hand-dyed blue swatches, held against the sky to read its blueness as a number. It is an instrument that reads a continuous value off a graded colour scale — which is precisely what retrievability is. The metaphor hands us the palette and the data scale as one object.

### Colour

```
--ground       #0B2130   deep Prussian, the page
--ground-lift  #12384A   raised surface — card body, sheets, editor fields
--hairline     #1E4A5E   separators, field outlines
--ink          #EAF0F0   primary type, bone white
--ink-quiet    #7FA0AE   labels, intervals, secondary type
--brass        #E3B23C   due now / the one action — and nothing else
```

The cyanometer scale — **retrievability, faded to fresh**:

```
--r-0  #1B4C6B   R < .70    ░  due
--r-1  #2E7EA3   .70 – .85  ▒
--r-2  #6FB4CE   .85 – .95  ▓
--r-3  #CFE7EE   R > .95    █  fresh
```

Rules: **the blue ramp is data, never decoration.** A colour that is not encoding retrievability or signalling due-ness does not appear. `--r-0` is deliberately low-contrast against the ground — faded memory *looks* faded — so ramp marks never carry meaning alone; every mark sits beside a label or a position that says the same thing.

Dark ground is a use-case decision, not a default: this is read in bed and on transit. `#0B2130` is a saturated blue, not a tinted near-black.

### Type

Two families, sharply divided by job — chrome is the instrument, content is the specimen under it, and they must never be confused.

- **Instrument Sans** (variable, self-hosted via `@fontsource-variable`) — all interface: labels, buttons, counts, intervals. Set intervals with `font-variant-numeric: tabular-nums`.
- **Literata** (variable, self-hosted) — card content only. Designed for extended screen reading, wide script coverage, true italics.

Scale (1.25 modular):

| role | size / leading | family |
|---|---|---|
| cue side | 2.99rem / 1.15 | Literata 400 |
| card content | 1.25rem / 1.7 | Literata 400 |
| side label | 0.8rem / 1.3, 500, `--ink-quiet` | Instrument Sans |
| interface | 1rem / 1.4 | Instrument Sans |
| interval, count | 0.875rem, tabular | Instrument Sans |

Content measure capped at 34em. Serif gets the extra leading (1.7) it needs.

**Forbidden, as the commonest tells:** all-caps labels, monospace anywhere, `→` appended to button text, meta strings joined by `·`, an eyebrow label above a heading, accenting one word of a phrase in a different colour.

### Layout

Single column, `max-width: 34rem`, centred in the viewport, **content left-aligned**. The one centred element in the whole app is the cue side — it is a specimen under glass, and centring it is what marks it as different from everything else.

The bottom third is reserved for actions; the grade bar pins above `env(safe-area-inset-bottom)`. One 44px top strip carries back / deck / remaining — title bars never stack.

### Motion

**One orchestrated moment: the unfold.** It answers a tap and shows what changed, which is the only kind of motion that earns its place here.

- Cue docks from centre to top strip: `transform`, 220ms `cubic-bezier(.2,.7,.2,1)`.
  One element in two states, moved with a FLIP — not two elements cross-fading.
  `CueCard` therefore lives outside the phase branch; that is the mechanism, not
  tidiness.
- Revealed sides stagger in 40ms apart, 6px rise + fade.
- Grading plays the same dock in reverse, because it is the same element: the
  next cue rises out of the strip. There is no separate collapse animation —
  one moment, played both ways, is the whole motion budget.
- Nothing else moves. No hover transitions (it's a touch device), no section entrances.
- `prefers-reduced-motion: reduce` → cross-fade only, no transform, no stagger.
  One media block; a second one only loses to the first's `!important`.

### Principles

1. The ramp is data. If a colour isn't encoding retrievability or due-ness, cut it.
2. The card doesn't flip — it unfolds. Structure follows N sides, not two.
3. Brass means act now, and means nothing else.
4. No streaks, no confetti, no counts as motivation. The instrument reports; it does not cheer.
5. Everything reachable by one thumb, in the bottom third.

### Why this isn't the generic answer

Run this brief cold and you land on: a dark-grey app, Inter, a blue accent, a flipping card, a streak counter, and a big "23 due" number over a small label. Every one of those is refused here. The palette comes from a named historical instrument that measures a continuous value off a colour ramp; the ramp does real encoding work; the card unfolds because it has N sides; and the home screen's hero is a distribution of the actual algorithm state, not a count.

### Alternative palettes considered

Two other directions were worked up before Cyanometer was chosen. Both are
recorded in full, with measurements, because a palette is a decision and the
next person to reopen it should not have to redo the arithmetic.

**Herbarium** — pale bone paper, iron-gall ink, one dried-madder red. Cards as
pressed specimens on a mounting sheet; memory strength shown as pigment fading.

```
ground   #EDE8DC   bone paper      raised  #F6F3EA
ink      #23282A   iron gall       quiet   #7C7566   3.74:1
madder   #9E3B32   due now         5.50:1
ramp     #CFC6B4  #A79878  #6E6448  #23282A
         1.39:1   2.32:1   4.80:1   12.20:1     ← first two fail the 3:1 floor
```

**Signal & noise** — near-neutral graphite with a single high-chroma signal,
type set very tight and large.

```
ground   #16181A   graphite        raised  #202325
ink      #F2F2F0                   quiet   #85898C   5.05:1
signal   #B7F04A   due now         13.20:1
ramp     #3A3E40  #5E6467  #949A9D  #F2F2F0
         1.65:1   2.96:1   6.25:1   15.88:1     ← first two fail the 3:1 floor
```

**Why each was set aside.** Herbarium is warmer and more tactile, but a light
ground is the wrong choice for an app used in bed at low brightness, and bone
paper with a serif lands close to the commonest generated-page look. Signal &
noise is bolder and more graphic, but it is the least grounded in the subject
matter — a graphite ground with one acid accent is a default rather than a
choice, and it leans entirely on execution.

**What measuring them actually taught.** Every one of the three palettes, this
document's included, failed the 3:1 floor on its faded steps when picked by eye.
That failure is not a property of any hue; it is what happens when a sequential
ramp is chosen for how it looks rather than for its lightness. Re-stepped to
pass, the three compare like this:

| direction | ground | usable lightness range | verdict |
|---|---|---|---|
| Cyanometer | dark | **0.630** (`.154` → `.784`) | chosen |
| Signal & noise | dark | **0.742** (`.145` → `.887`) | works; re-steps cleanly |
| Herbarium | light | **0.194** (`.020` → `.215`) | ramp collapses |

A light ground costs a sequential ramp roughly three-quarters of its range,
because "faded" naturally wants to be *light* — and on bone paper a light mark
is an invisible one, so every step has to be dark enough to be seen instead. The
metaphor inverts the encoding. That is the strongest argument for the dark
ground, stronger than the reading-in-bed one this document opened with.

Either alternative could be adopted by swapping the tokens at the top of
`web/src/ui/tokens.css`; nothing else reads a colour literal. The re-stepped
ramps below already clear 3:1 with monotonic lightness, so they are drop-ins:

```
Herbarium        #8A7F62  #6E6448  #4A4433  #23282A   (3.25 / 4.80 / 7.93 / 12.20)
Signal & noise   #666B6E  #8E9497  #B9BEC0  #F2F2F0   (3.30 / 5.79 / 9.49 / 15.88)
```

Herbarium would additionally need its `--ink-quiet` re-checked: at 3.74:1 it
clears the mark for large text but sits under the 4.5:1 body-text threshold.

---

## 4. Screens

### Today — the home screen

The hero is **the cyanometer strip**: every side in the collection, placed along the retrievability ramp. You see the *shape* of your memory — a bright mass on the right, a fringe sliding left into the brass band. This is the app's characteristic image and no template produces it.

Drawn as a histogram, not a sorted strip of one mark per side — with four ramp
steps a sorted strip collapses into a proportion bar, which is the generic
answer (§11). Two things make it read:

- **The axis is banded, not linear.** Each ramp band gets an equal quarter of
  the width, subdivided evenly inside it. FSRS schedules a side for the moment
  its recall reaches the retention target, so on a linear axis every side that
  is not yet due crowds into the top tenth of the scale. Banding also lands the
  axis ticks exactly where the colour changes.
- **Height is the square root of the count.** The distribution is heavily
  skewed — everything reviewed in the last few days sits at R near 1 — and on a
  linear height the rightmost bin takes the full plot and flattens the left-hand
  tail, which is the half worth looking at. Exact counts live in the readout.

Brass is not a bar colour: it is a rule beneath the axis marking the stretch
that is already due, so it stays one contiguous mark and no bar is part-brass.

```
┌─────────────────────────────┐
│ eidet             synced 2m │
│                             │
│  due          strong        │
│ ┃░░▒▒▓▓█████████████████████│   ← every side, by R
│ ┗━ brass band = due now     │
│                             │
│  ┌───────────────────────┐  │
│  │    Review 43 sides    │  │   ← brass, the one action
│  └───────────────────────┘  │
│                             │
│  Kanji               28 due │
│  ░░▒▓████                   │
│  Anatomy             11 due │
│  ░▒██                       │
│  Bird calls           4 due │
│  ░█                         │
│                             │
│                    Add deck │
└─────────────────────────────┘
```

Empty state is an invitation, not a mood: *"Nothing due. Next batch in 4 hours."*

### Review — cue

```
┌─────────────────────────────┐
│ ‹  Kanji             17 left│
│▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░│   ← session progress hairline
│                             │
│                             │
│                             │
│             憂              │   ← Literata, 2.99rem, centred
│                             │
│           reading           │   ← which side is cueing you
│                             │
│  ╌╌╌╌╌╌╌╌ 2 hidden ╌╌╌╌╌╌╌  │   ← the fold line
│                             │
│                             │
│  ┌───────────────────────┐  │
│  │        Reveal         │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

### Review — revealed

```
┌─────────────────────────────┐
│ ‹  Kanji             17 left│
│▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░│
│  憂  reading                │   ← cue docked, small
│  ───────────────────────────│
│                             │
│  meaning              ▓▓▓░  │   ← side label + its own ramp
│  grief, melancholy          │
│                             │
│  on-reading           ▒░    │
│  ユウ                       │
│                             │
│  mnemonic                   │   ← untested: dimmed, no grade
│  a heart under autumn       │
│                             │
│  ───────────────────────────│
│  Again   Hard   Good   Easy │   ← applies to all unmissed rows
└─────────────────────────────┘
```

Tapping a side row toggles it **missed** — the row dims and takes a brass left rule. Whole-row tap targets, no small icons.

### Deck

List of cards; each row shows its sides as small ramp marks so you can see at a glance which cards are decaying. Search, add card, deck settings (fields, cue preference, mode).

### Card editor

**All sides together, always** — per the brief, storage and editing are card-level even though scheduling is side-level. Text or image per side, reorder, add/remove. Each side shows its schedule state read-only — its ramp mark, when it is next due, how many reviews it has had — so edits are informed. Set as separate spans, not a `·`-joined string: §3 forbids those, and these two sections used to contradict each other. Editing a side's *content* does not reset its memory — an explicit "reset schedule" action does.

Image sides: capture or pick from the phone, downscale client-side to a max edge of 1600px, store the blob locally, upload when reachable.

### Settings

Sync status and manual sync, FSRS parameters, storage used, export. Reached from
the sync line in the home screen's top strip: the state and the place to do
something about it are the same control.

`request_retention` and the learning steps are both part of the stored
`ParamSet`, so changing either writes a new one — they are immutable and keyed
by content hash — and replays every side's log under it (§2). Slow and
deliberate, hence a button rather than a live control. Deck reordering and
per-side reordering live with the thing they order, in deck settings and the
card editor.

---

## 5. Data model

SQLite on the server, mirrored one-for-one as Dexie tables on the client.

```
decks    (id, name, mode, fields JSON, cuePreference, order, updatedAt, deletedAt, seq)
cards    (id, deckId, sides JSON, updatedAt, deletedAt, seq)
           sides: [{ id, fieldId|label, kind:'text'|'image', value, tested }]
memory   (sideId PK, cardId, deckId, due, stability, difficulty,
          reps, lapses, state, lastReview, learningSteps)          -- derived
reviews  (id PK, sideId, cardId, cueSideId, rating, reviewedAt,
          memoryBefore JSON, memoryAfter JSON, params JSON, seq)   -- append-only
blobs    (sha256 PK, mime, bytes, width, height, createdAt)
paramSets(hash PK, w JSON, requestRetention, learningSteps JSON, createdAt, seq)
```

- **`sides` are a JSON column on `cards`, not their own table.** Cards are always read, written, and edited whole; splitting them would buy nothing and cost a join on every read.
- **`memory` is derived** — always equal to the `memoryAfter` of the newest review for that side. It is materialised for query speed (the due queue is one indexed range scan on `due`), never authoritative.
- **`reviews` is append-only and immutable.** This is what makes sync nearly conflict-free (§6) and what feeds the optimiser (§9 phase 4).
- **`blobs` are content-addressed by SHA-256**, so they are immutable, deduplicated, and cacheable forever.

---

## 6. Offline architecture

### Why not AisleFlow's data layer

AisleFlow caches *server responses* with TanStack Query and queues mutations. That is right for a shopping list and wrong here: eidet must review offline, which needs the **whole corpus plus images resident on the device** and the scheduler running locally. So the device holds the source of truth and a sync engine reconciles it, rather than the network holding truth and a cache standing in.

### Three layers

**1. Service worker** — `vite-plugin-pwa` precaches the app shell. Prod-only (`devOptions.enabled: false`); `prompt` update mode, matching AisleFlow's `UpdatePrompt` pattern.

**2. IndexedDB via Dexie** — the device's source of truth. React reads through `useLiveQuery` from `dexie-react-hooks`, so any write re-renders its readers with no cache-invalidation layer at all. All scheduling reads and writes are local and synchronous-ish; the network is never on the critical path of a review.

**3. Sync engine** — a background loop reconciling local and server, split by data class:

| class | rows | strategy |
|---|---|---|
| append-only | `reviews` | union by id — **cannot conflict** |
| mutable | `decks`, `cards` | last-write-wins on `updatedAt`, tombstones via `deletedAt` |
| immutable | `blobs` | content-addressed; upload if absent, never modified |

```
GET  /api/changes?since=<seq>   → { seq, decks[], cards[], reviews[], blobs[] }
POST /api/changes               ← { decks[], cards[], reviews[] } → { seq }
PUT  /api/blobs/:sha256         idempotent upload
GET  /api/blobs/:sha256         immutable, Cache-Control: immutable, max-age=31536000
GET  /api/healthz               reachability probe — must not be SW-cached
```

The server stamps a monotonic `seq` on every row it writes; the client's cursor is its high-water mark. Blob transfer runs on its own queue so a large image never blocks a review from syncing.

LWW is honest here because there is one user with one primary device. The accepted caveat: editing the same card on two devices while both are offline loses one edit. Reviews never lose.

### Reload returns to exactly the same state

A `session` record in IndexedDB, written on **every** state transition:

```ts
{ id, deckIds, queue: CardBatch[], index, phase: 'cue' | 'revealed',
  missedSideIds, startedAt, gradedCount, lastCommit }
```

`cueSideId` sits on each `CardBatch`, where it belongs — it is per card, not per
session. There is no `seenAsCueSideIds`: the sight cooldown is structural, not a
rule to enforce (§11). `lastCommit` is what undo needs (§9).

The route is `/review/:sessionId`, so the URL itself survives reload. On boot: load the session, restore queue, index, phase, and missed toggles. Already-graded sides are already rows in `reviews`, so nothing is re-asked. A separate small `uiState` record (the `ui` table, keyed by string) restores deck scroll position and open editor drafts.

This is the requirement most likely to rot silently — it gets a dedicated Playwright suite (§10).

### iOS specifics — non-negotiable

- **`tailscale serve` must terminate HTTPS.** Service workers require a secure context; over plain `http://100.x.x.x` there is no SW, no install, no offline. HTTPS on the `ts.net` name is a hard dependency, not a nicety.
- **The app must be added to the Home Screen.** iOS Safari evicts IndexedDB after ~7 days without use for ordinary sites; installed PWAs are exempt. For an app that may go a fortnight between sessions, this is the difference between working and losing local state. Say so in the README and in a first-run hint.
- `viewport-fit=cover` + `env(safe-area-inset-*)`; `100dvh`, never `100vh`.
- `touch-action: manipulation` (kills double-tap zoom on the grade bar), `overscroll-behavior: contain` (kills rubber-band during review), `-webkit-text-size-adjust: 100%`.
- Home-screen icons and `apple-mobile-web-app-status-bar-style: black-translucent`.

---

## 7. Repo layout

pnpm workspace (pnpm 11 installed; matches `jelly-sim`), three packages, one language throughout.

```
eidet/
├── DESIGN.md              authoritative design doc; code comments cite its §§
├── CLAUDE.md              commands, ports, invariants
├── Makefile               dev / build / test / e2e / deploy
├── pnpm-workspace.yaml
├── shared/src/
│   ├── types.ts           Deck, Card, Side, Memory, Review, sync envelope
│   ├── schedule.ts        ts-fsrs wrapper: grade(), retrievability(), replay()
│   └── queue.ts           due-queue build, cue selection, batching  ← pure, heavily tested
├── server/src/
│   ├── index.ts           node:http, serves dist/ in prod
│   ├── db.ts              node:sqlite, schema + migrations
│   ├── changes.ts         GET/POST /api/changes
│   └── blobs.ts           content-addressed blob store on disk
└── web/
    ├── src/db/            Dexie schema, useLiveQuery hooks
    ├── src/sync/          sync loop, reachability, blob queue
    ├── src/session/       session record, restore-on-boot
    ├── src/screens/       Today, Review, Deck, CardEditor, Settings
    ├── src/ui/            tokens.css, Ramp, Cyanometer, CueCard, SideRow, GradeBar
    └── e2e/               Playwright: offline, reload-restores-state, PWA
```

`shared/src/queue.ts` and `shared/src/schedule.ts` hold **all** scheduling logic; screens never do date maths. They are pure functions over plain data, which is what makes the whole review model testable without a browser.

No component library — MUI would fight the visual system for no gain.
Hand-rolled CSS with custom properties, in **one global stylesheet**
(`ui/tokens.css`). CSS Modules were the original plan and would have prevented
the handful of ordering collisions the single file allowed; they were not worth
splitting 700 coherent lines apart for. The rule that replaces them: never stack
a typographic class (`.label`, `.content`) onto an element whose own class
overrides it — set both properties in the one place.

**Ports** (5173/5174/5176/5199/5273, 8080–8082/8090/8096/8173, Postgres 5432/5434/5435 and `tailscale serve` 443/8443/8444 are taken by other projects on this machine): dev web **5175**, dev server **8083**, deployed **8091**. The Playwright suite runs its own server on **8087**.

The deployed instance is a systemd *user* unit, `~/.config/systemd/user/eidet.service`, bound to `127.0.0.1:8091` — loopback only, because the app has no auth (§1 non-goals) and the sole way in is the proxy. `tailscale serve` publishes it to the tailnet on **:8445** (`tailscale serve --bg --https=8445 http://127.0.0.1:8091`), which is where the HTTPS of §6 comes from. The unit carries that command in `ExecStartPost` and its `off` in `ExecStopPost`, so the unit stays the single source of truth for how eidet is exposed even though tailscaled persists the serve config itself. It runs against the same `data/` as `make dev`: one set of cards is the point, and `db.ts` sets a `busy_timeout` so the overlap waits rather than failing. `make deploy` restarts it; `journalctl --user -u eidet -f` is the log.

---

## 8. Copy voice

Plain, active, present tense, sentence case. Buttons name what happens: `Reveal`, `Review 43 sides`, `Add deck`, `Reset schedule`. An action keeps its name through the flow.

Offline is a state, not an error: *"Saved here. Syncs when the server is reachable."* Errors say what happened and what to do: *"Couldn't reach the server. Your reviews are saved on this phone."* Emptiness invites: *"No cards yet. Add one."*

---

## 9. Build order

**Phase 1 — the model.** `shared/`: types, `schedule.ts` over `ts-fsrs`, `queue.ts` (due queue, cue selection, sight cooldown, batching). Vitest against it, including a replay-vs-snapshot property test. No UI. This is the part that must be right.

**Phase 2 — local-only app.** Dexie schema, `useLiveQuery` hooks, session record + restore, and the three screens that matter: Today, Review, CardEditor. Full design system in `tokens.css`. Text sides only. Works entirely offline with no server at all — proving the offline story by construction rather than bolting it on.

**Phase 3 — server and sync.** `node:sqlite` schema, `/api/changes`, sync loop, reachability probe. Then images: client downscale, content-addressed blob store, blob upload queue. Then PWA: `vite-plugin-pwa`, manifest, iOS icons, `tailscale serve`, systemd user unit.

**Phase 4 — refinement.** The cyanometer strip on Today; undo (see §11 — via the
review's own `memoryBefore`, not `scheduler.rollback`); deck settings; FSRS
parameter optimisation from the review log (`@open-spaced-repetition/binding` `computeParameters` → 21-element `w`, run server-side on demand, then replay).

> Load the **`dataviz`** skill before writing the cyanometer strip in phase 4 — it is a real distribution chart and should be built as one.

---

## 10. Verification

**Unit (vitest, `shared/`)** — the highest-value tests, all pure:
- Cue selection picks the highest-retrievability non-due side; falls back correctly when every side is due.
- Sight cooldown: a side used as a cue is never a target later in the same session.
- Batching: all due sides of one card appear in exactly one reveal.
- Grade fan-out: `Good` with two rows marked missed writes `Again` for those two and `Good` for the rest.
- Replay: folding a review log from `createEmptyCard()` with fuzz disabled reproduces the stored snapshots.

**Component (vitest + jsdom, `web/`)** — reveal shows every non-cue side; untested sides render without a grade row; missed toggle survives a re-render.

**End-to-end (Playwright, `web/e2e/`)** — run against a prod build, never the dev server (the SW is prod-only):
1. **Offline review.** Load, go offline, review 10 sides across three decks, confirm reviews land in IndexedDB and no request escapes.
2. **Reload restores exactly.** Mid-session, mid-reveal, with two rows marked missed → reload → identical screen, same queue position, same toggles, nothing re-asked. Also mid-edit in the card editor.
3. **Sync convergence.** Queue reviews offline, come back online, confirm the server has them and a second client pulls them.
4. **Cold start offline.** Fresh load with the network already down, from precache alone.

Note AisleFlow's e2e gotchas — they apply verbatim: Playwright's `setOffline` doesn't set `navigator.onLine` on freshly loaded documents (an init-script shim is what stops the reload-while-offline test passing on the online path), and precaching must finish before the network is cut.

**On the actual phone.** The design targets a 390pt iPhone viewport and one thumb; check the grade bar clears the home indicator, that Literata renders the deck's real script, and — the one thing no test catches — that reviewing in a dark room at low brightness is comfortable. Install to the Home Screen and confirm state survives a week.

---

## 11. Decisions made during the build

Recorded here because they changed the design, not just the code.

- **The sight cooldown is structural, not a rule.** A card appears in the queue
  exactly once and all its due sides land in one reveal, so a side can never be
  shown as a cue and then asked as a target. There is nothing to enforce.
- **Cue preference order was wrong in the first draft.** It reached for any
  non-target side before considering the natural front→back direction, which
  meant a card with an untested source note got prompted by the note. The order
  is now: pinned field → best-known *tested* side → lift the best-known target
  out → untested side as a last resort. `queue.test.ts` pins this.
- **`grade()` takes an explicit `fuzz` flag.** Replay needs it off, and so do
  tests that assert an exact interval. The property that motivated the whole
  stored-snapshot design is now asserted directly: under fuzz, a fold over the
  log recovers stability and difficulty but *not* `due`.
- **Sync runs at the app root, not on the home screen.** Mounted alongside
  `Today` it stopped the moment a review started — precisely when there is
  something to push. It lives in `SyncProvider` now.
- **A local write nudges the sync loop** (700 ms debounce, `onDirty` in
  `db/db.ts`). Waiting out a 30 s poll made "stores to the server" feel broken
  when the server was in fact right there.
- **`erasableSyntaxOnly` is on across the workspace.** The server runs under
  Node's type stripping, which erases types but cannot emit code; a constructor
  parameter property compiled fine and crashed at startup. The compiler catches
  that class of error now.
- **The ramp was re-stepped for contrast.** The first palette's faded end sat at
  1.8:1 on the ground — a mark you cannot see cannot carry information. The four
  steps are now 3.2 / 5.3 / 8.8 / 13.1:1 with monotonic lightness, which is the
  right check for a sequential ramp (the categorical adjacent-pair rule does not
  apply to one).
- **The hero is a histogram, not a stacked bar.** A five-segment proportion bar
  was both generic and mostly brass. A distribution shows real shape and
  confines brass to a single mark. Note that this changed the *form* only — the
  variable is still retrievability, as §4 always said. An intermediate version
  binned by due date instead, which quietly gave a ramp colour two meanings: R
  everywhere in the app, and "due in a month" on the one screen where the ramp
  is the whole point. Position and colour now encode the same number again.
- **Dexie cannot index booleans**, so `LocalBlob.uploaded` is `0 | 1`. It is the
  field the upload queue scans, so it has to be indexed.
- **Undo restores the stored snapshot; `scheduler.rollback` is never called.**
  Every review already carries the exact `memoryBefore` it replaced — the same
  reason §2 gives for storing `memoryAfter` — so backing one out is a `put`, not
  a recomputation.
- **Undo is offered only while the commit is unsent.** Reviews are append-only
  and immutable, and that is the single property making sync conflict-free (§6).
  A review that has reached the server is part of a shared log and stays; one
  still in the outbox has no standing anywhere and can simply go. The outbox is
  keyed `table:rowId`, so "unsent" is an exact check, and the affordance is
  absent rather than failing under the thumb.
- **A push and an undo take the same lock.** "Still in the outbox" is only
  honest if nothing can move the row while it is read: a push holds its rows
  there for the whole request, so between the POST and the clear the entry
  stands for a review the server has already taken. Undo then deleted a row the
  next pull brought straight back, memory and all — an undo that quietly
  reversed itself. Both sides now run under `withSendLock`, so the two happen in
  one order or the other: undo before the batch is collected, and the review
  never leaves; or after the outbox is cleared, where it declines. What is left
  is delivery the device cannot observe — the server commits and the response is
  lost — which errs towards keeping a review, the direction this section asks
  for.
- **A push clears only the edits it sent.** The outbox is a set of dirty rows,
  not a log of edits, so a row touched again during the request sits under the
  key the push is about to delete. Clearing by id alone dropped that edit; the
  comparison is on `queuedAt`.
- **A live query must not write to a table it reads.** `currentParams` creates
  the parameter set when there isn't one, and reading it through `useLiveQuery`
  re-triggered the query forever. On a device that already had a set the loop
  never started, so it only appeared on a first run — where it hung the home
  screen. Creation happens in an effect now (`db/useParams.ts`); the query is a
  pure read.
- **The pull cursor is read off the raw rows, not the mapped objects.** `Review`
  and `ParamSet` deliberately carry no `seq`, so deriving the high-water mark
  from them scored every review as 0 and pinned the cursor at `since`: a client
  with more than one page of reviews re-pulled the same page forever.
- **And it is the lowest last-`seq` among the tables that filled their page**,
  not the highest seen anywhere. Tables page independently, so a backlog of
  reviews plus a later deck edit puts the deck above the reviews' boundary, and
  the maximum hands back a cursor past reviews this page could not fit —
  stranding them for good. A table that did not fill its page may see a row
  twice; every write is idempotent, so that costs nothing, while a skipped row
  is never asked for again.
- **The brass rule is under the hero's axis, not in its bars.** Due-ness and
  retrievability nearly but not exactly coincide, so painting bars brass left a
  boundary bin that was honestly neither. An axis annotation is one contiguous
  mark at a fixed, principled position — the retention target.
- **Ramp marks are taken over every side of a deck, not only the ones not due.**
  A side is scheduled for the moment its recall reaches the target, so the
  not-due sides are all fresh by construction and a mark computed from them read
  identically for every deck. A mark that never varies carries no information.

## Open items

- FSRS parameter optimisation (phase 4) needs `@open-spaced-repetition/binding`, a native/WASM module — confirm it builds on this host before committing to server-side training. Everything downstream of it is already in place: `ParamSet`, `paramsHash`, `replayAll`, and a settings screen that writes a new set and replays.
- Deck import (Anki `.apkg`, CSV) is out of scope but the free-form deck mode is the natural landing zone if it's wanted later.
- The ramp's bands (`.70 / .85 / .95`) are calibrated for reading a *side*, not a
  collection. Because a side falls due exactly when its recall reaches the
  retention target, in practice only the top two bands ever describe a side that
  is not due; the lower two are the overdue tail. That is why the home screen's
  histogram bands the axis rather than scaling it linearly. Worth revisiting if
  the per-deck ramp marks still read alike on a real collection.
