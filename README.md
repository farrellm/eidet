# eidet

Spaced repetition for cards with any number of sides.

A card is not a front and a back. It is a set of sides — a glyph, a reading, a
meaning; a species and its song — and **each side carries its own memory
state**. One side prompts, the rest are revealed together, and every due side is
graded independently. Scheduling is FSRS-6.

Built to be used on a phone over a tailnet, offline, with no account.

## Running it

```bash
pnpm install
make dev          # web on :5175, server on :8083
make check        # typecheck + unit tests
make e2e          # offline/PWA suite against a production build
```

## On the phone

Two things are not optional:

- **`tailscale serve` must terminate HTTPS.** Service workers need a secure
  context. Over plain `http://100.x.x.x` there is no service worker, no install,
  and no offline mode at all.
- **Add it to the Home Screen.** iOS evicts IndexedDB after about seven days of
  disuse for ordinary sites; installed web apps are exempt. For something you
  might not open for a fortnight, that is the difference between working and
  losing your local state.

See [DESIGN.md](DESIGN.md) for the design; it is the authoritative document and
the code cites its sections.
