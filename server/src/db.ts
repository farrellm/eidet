/**
 * The server's store. See DESIGN.md §5, §6.
 *
 * SQLite through Node's built-in `node:sqlite` — no container, no ORM, no
 * migration tool. The server runs no scheduling logic at all: it stamps a
 * monotonic `seq` on everything it accepts and hands rows back in `seq` order.
 * That sequence is the whole sync protocol.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * Migrations are a numbered list applied in order and recorded in
 * `user_version`. Append; never edit one that has shipped.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE decks (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    mode          TEXT NOT NULL,
    fields        TEXT NOT NULL,
    cuePreference TEXT NOT NULL,
    "order"       INTEGER NOT NULL,
    updatedAt     INTEGER NOT NULL,
    deletedAt     INTEGER,
    seq           INTEGER NOT NULL
  );
  CREATE INDEX decks_seq ON decks(seq);

  CREATE TABLE cards (
    id        TEXT PRIMARY KEY,
    deckId    TEXT NOT NULL,
    sides     TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    deletedAt INTEGER,
    seq       INTEGER NOT NULL
  );
  CREATE INDEX cards_seq ON cards(seq);

  -- Append-only and immutable: a review is never updated, only inserted.
  CREATE TABLE reviews (
    id           TEXT PRIMARY KEY,
    sideId       TEXT NOT NULL,
    cardId       TEXT NOT NULL,
    deckId       TEXT NOT NULL,
    cueSideId    TEXT,
    rating       INTEGER NOT NULL,
    reviewedAt   INTEGER NOT NULL,
    memoryBefore TEXT,
    memoryAfter  TEXT NOT NULL,
    paramsHash   TEXT NOT NULL,
    seq          INTEGER NOT NULL
  );
  CREATE INDEX reviews_seq ON reviews(seq);

  CREATE TABLE paramSets (
    hash             TEXT PRIMARY KEY,
    w                TEXT NOT NULL,
    requestRetention REAL NOT NULL,
    createdAt        INTEGER NOT NULL,
    seq              INTEGER NOT NULL
  );
  CREATE INDEX paramSets_seq ON paramSets(seq);

  CREATE TABLE blobs (
    sha256    TEXT PRIMARY KEY,
    mime      TEXT NOT NULL,
    bytes     INTEGER NOT NULL,
    width     INTEGER NOT NULL,
    height    INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    seq       INTEGER NOT NULL
  );
  CREATE INDEX blobs_seq ON blobs(seq);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO meta (key, value) VALUES ('seq', 0);
  `,
]

function migrate(db: DatabaseSync) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    version = i + 1
  }
}

/** The next write sequence. Monotonic across every table — it is the cursor. */
export function nextSeq(db: DatabaseSync): number {
  db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'seq'").run()
  const row = db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: number }
  return row.value
}

export function currentSeq(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'seq'").get() as { value: number }
  return row.value
}
