/**
 * Content-addressed image store. See DESIGN.md §5, §6.
 *
 * Blobs are keyed by the SHA-256 of their bytes, so they are immutable,
 * deduplicated, and safe to cache forever. Upload is idempotent: re-sending the
 * same image is a no-op, which is what lets the client's upload queue retry
 * freely after a dropped connection.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { nextSeq } from './db.ts'

const MAX_BYTES = 8 * 1024 * 1024

export class BlobStore {
  // Plain fields, not constructor parameter properties: the server runs under
  // Node's type stripping, which erases types but cannot emit code.
  private db: DatabaseSync
  private dir: string

  constructor(db: DatabaseSync, dir: string) {
    this.db = db
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  /** Two-level fan-out, so a directory never holds a hundred thousand files. */
  private path(sha256: string) {
    const shard = join(this.dir, sha256.slice(0, 2))
    mkdirSync(shard, { recursive: true })
    return join(shard, sha256)
  }

  has(sha256: string): boolean {
    return this.db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha256) !== undefined
  }

  async put(
    sha256: string,
    data: Buffer,
    meta: { mime: string; width: number; height: number },
  ): Promise<{ stored: boolean; error?: string }> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return { stored: false, error: 'bad digest' }
    if (data.byteLength > MAX_BYTES) return { stored: false, error: 'too large' }

    // Verify rather than trust: the name of a content-addressed file has to be
    // its content, or the store stops being immutable and cacheable.
    const actual = createHash('sha256').update(data).digest('hex')
    if (actual !== sha256) return { stored: false, error: 'digest mismatch' }

    if (this.has(sha256)) return { stored: true }
    await writeFile(this.path(sha256), data)
    this.db
      .prepare(
        'INSERT INTO blobs (sha256, mime, bytes, width, height, createdAt, seq) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING',
      )
      .run(sha256, meta.mime, data.byteLength, meta.width, meta.height, Date.now(), nextSeq(this.db))
    return { stored: true }
  }

  async get(sha256: string): Promise<{ data: Buffer; mime: string } | null> {
    const row = this.db.prepare('SELECT mime FROM blobs WHERE sha256 = ?').get(sha256) as
      | { mime: string }
      | undefined
    if (!row) return null
    try {
      return { data: await readFile(this.path(sha256)), mime: row.mime }
    } catch {
      return null
    }
  }
}
