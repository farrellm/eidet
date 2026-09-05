# eidet

Spaced repetition for cards with **any number of sides**, used on an iPhone over
Tailscale, fully functional offline. TypeScript throughout: React/Vite PWA +
Node `node:sqlite` server, pnpm workspace of three packages.
**DESIGN.md is the authoritative design doc** — code comments cite its sections
(§1 review loop, §2 FSRS, §3 visual system, §5 data model, §6 offline & sync);
keep those references valid when editing.

## Commands

```bash
make dev          # web :5175 + server :8083
make check        # typecheck + unit tests, every package
make e2e          # offline/PWA suite (builds first; needs a prod build)
make build        # vite build -> web/dist, incl. service worker
```

- **Ports: web 5175, server 8083, deployed 8091, Playwright 8087.**
  5173/5174/5176 and 8080–8082/8090 belong to other projects on this machine.
  Vite proxies `/api` → 8083. The e2e run wipes `web/.e2e-data` first: the suite
  asserts exact row counts, so a leftover database makes every one of them wrong
  in a way that looks like a sync bug.
- Server data lives in `EIDET_DATA` (default `./data`): `eidet.db` plus a
  content-addressed `blobs/` tree.

## The one idea everything follows from

**The scheduling unit is a side, not a card.** Each testable side owns its own
FSRS memory. A card's sides are stored and edited together; they are *scheduled*
apart. If a change makes sense for "a card's schedule", it is probably wrong.

## Architecture

- `shared/src/` — the model, all pure. `schedule.ts` is the **only** file that
  imports `ts-fsrs`; `queue.ts` owns due selection, cue choice and batching.
  Screens never do date maths.
- `server/src/` — stores and syncs, **never schedules**. `changes.ts` is the
  whole protocol; `db.ts` owns the numbered migration list and the `seq`
  counter.
- `web/src/db/` — Dexie is the device's source of truth (not a response cache);
  `mutations.ts` holds every write. `web/src/sync/` reconciles with the server.
  `web/src/session/` owns the review session record.

## Invariants and gotchas

- **`memory` is derived**: always the `memoryAfter` of a side's newest review,
  never computed on a read path. Fuzz makes a fold over the log
  non-deterministic, which is exactly why the snapshot is stored. `replay()`
  (fuzz off) is for parameter changes only.
- **Reviews are append-only and immutable.** That is what makes sync
  conflict-free for the one class of data that must never be lost. Decks and
  cards are last-write-wins on `updatedAt` with `deletedAt` tombstones.
- **Undo only reaches unsent reviews.** It deletes the commit's rows and puts
  back each review's stored `memoryBefore`; `scheduler.rollback` is not used.
  Once a review is pushed the affordance is gone — withdrawing it would break
  the append-only property everything above rests on.
- **A pull must not clobber unsent local edits.** `pullChanges` skips any row
  still in the outbox. Dropping that check silently eats work done offline;
  `sync/sync.test.ts` pins it.
- **The pull cursor comes from the raw SQL rows.** `Review` and `ParamSet` carry
  no `seq` field, so computing the high-water mark from the mapped objects
  stalls a client's cursor forever once it has a page of reviews to catch up on.
- **Sync lives at the app root** (`SyncProvider`), never inside a screen — it
  once stopped during reviews, which is when there is most to push. A local
  write nudges it via `onDirty` (700 ms debounce).
- **The session record is written on every transition** and the session id is in
  the URL. That pair is the whole "reload returns to the same state" guarantee;
  `e2e/offline.spec.ts` protects it. Card-editor drafts do the same through
  `db.ui` under a `draft:` key.
- **`erasableSyntaxOnly` is on.** The server runs under Node type stripping —
  no enums, no constructor parameter properties, no decorators, anywhere.
- **Dexie cannot index booleans**; `LocalBlob.uploaded` is `0 | 1`.
- **Never write to a table from inside a `useLiveQuery`.** It re-triggers the
  query that made the write. `currentParams()` creates a parameter set, so
  screens read it through `db/useParams.ts`, which creates in an effect and
  keeps the query a pure read.
- Blobs are content-addressed by SHA-256 and the server **verifies the digest**
  before storing. Never weaken that: immutability is what makes them cacheable
  forever and uploads idempotent.
- The service worker is **prod-only** (`devOptions.enabled: false`) and runs in
  `prompt` mode — an automatic reload could discard an ungraded reveal. Verify
  SW behaviour with `make e2e`, never the dev server.
- `/api/healthz` is the reachability probe and must stay out of every runtime
  cache, or an offline app will believe it is online.
- e2e gotcha: Playwright's `setOffline` does not set `navigator.onLine` on
  freshly loaded documents — the init-script shim in `e2e/helpers.ts` is what
  stops the reload-while-offline test passing on the online path. Wait for
  precaching before cutting the network.

## Visual system ("Cyanometer", §3)

Deep Prussian ground, bone ink, **brass means due-now and nothing else**. The
blue ramp encodes retrievability and is never decoration — if a colour is not
carrying data or signalling an action, cut it. Instrument Sans for chrome,
Literata for card content; the two must never be confused. No all-caps labels,
no monospace, no `→` in button text, no `·`-joined meta strings. Ramp steps must
clear 3:1 on the ground, and `--ink-quiet` must clear 4.5:1 on `--ground-lift`
as well as on `--ground`.

- **The cue is the only centred element.** `.cuecard` centres it; `.state` is
  the left-aligned block for every other full-screen message.
- **`CueCard` must stay outside the phase branch in `Review`.** One element in
  two states is what makes the dock a FLIP rather than a cross-fade; splitting
  it per phase silently downgrades the app's one orchestrated moment.
- One global stylesheet, not CSS Modules. Never stack `.label` or `.content`
  onto an element whose own class overrides them — source order decides, and it
  will bite.
