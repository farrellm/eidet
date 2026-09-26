/**
 * The server's store. See DESIGN.md §5, §6.
 *
 * SQLite through Node's built-in `node:sqlite` — no container, no ORM, no
 * migration tool. The server runs no scheduling logic at all: it stamps a
 * monotonic `seq` on everything it accepts and hands rows back in `seq` order.
 * That sequence is the whole sync protocol.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  // The deployed unit and `make dev` share one data directory, so two processes
  // can hold this file at once. Without a timeout the second writer gets an
  // immediate SQLITE_BUSY instead of a short wait.
  db.exec('PRAGMA busy_timeout = 5000')
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

  // Learning steps became part of the parameter set, so a change to them
  // produces a new hash and a replay, like any other parameter change.
  // Existing rows predate the setting and therefore used the FSRS defaults.
  `
  ALTER TABLE paramSets ADD COLUMN learningSteps TEXT NOT NULL DEFAULT '["1m","10m"]';
  `,
]

function migrate(db: DatabaseSync) {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let i = user_version; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    })
  }
}

/** Run `fn` in one transaction: committed if it returns, rolled back if it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()

/**
 * A prepared statement, compiled once per database and reused. A push stamps
 * and upserts row by row, so re-preparing the same SQL for every row was most
 * of what it cost.
 */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db)
  if (!cache) statements.set(db, (cache = new Map<string, StatementSync>()))
  let prepared = cache.get(sql)
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)))
  return prepared
}

/** The next write sequence. Monotonic across every table — it is the cursor. */
export function nextSeq(db: DatabaseSync): number {
  const row = stmt(db, "UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value").get()
  return (row as { value: number }).value
}

export function currentSeq(db: DatabaseSync): number {
  return (stmt(db, "SELECT value FROM meta WHERE key = 'seq'").get() as { value: number }).value
}
