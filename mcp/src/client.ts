/**
 * The MCP server's side of sync. See DESIGN.md §6.
 *
 * It is one more client of the same two calls the phone makes: it pulls decks
 * and cards, and pushes the rows it writes. It never touches SQLite and never
 * schedules — a pushed card gains its memories on each device's next pull,
 * through `reconcileMemories`, exactly as a card written on another phone would.
 */
import { createHash } from 'node:crypto'
import type { Card, CardId, Deck, DeckId, PullResponse, PushResponse, Sha256 } from '@eidet/shared'

/** The rows this client writes. Reviews and parameter sets stay the phone's. */
export interface Writes {
  decks?: Deck[]
  cards?: Card[]
}

export class EidetClient {
  // Plain fields, not constructor parameter properties: this runs under Node's
  // type stripping, which erases types but cannot emit code.
  readonly base: string
  readonly decks = new Map<DeckId, Deck>()
  readonly cards = new Map<CardId, Card>()
  private cursor = 0

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '')
  }

  /**
   * Catch the mirror up with the server. Incremental after the first call, so
   * it is cheap to run before every tool call — which is what lets an edit made
   * on the phone a minute ago be seen here. Reviews, parameter sets and blob
   * metadata ride along in each page and are dropped: nothing here needs them.
   */
  async refresh(): Promise<void> {
    for (;;) {
      const page = await this.request<PullResponse>(`/api/changes?since=${this.cursor}`)
      for (const deck of page.decks) keepNewer(this.decks, deck)
      for (const card of page.cards) keepNewer(this.cards, card)
      this.cursor = page.seq
      if (!page.more) return
    }
  }

  async push(writes: Writes): Promise<void> {
    await this.request<PushResponse>('/api/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decks: writes.decks ?? [], cards: writes.cards ?? [] }),
    })
    for (const deck of writes.decks ?? []) this.decks.set(deck.id, deck)
    for (const card of writes.cards ?? []) this.cards.set(card.id, card)
  }

  /** Upload an image, content-addressed. Idempotent, so a retry is harmless. */
  async putBlob(data: Buffer, mime: string): Promise<Sha256> {
    const sha256 = createHash('sha256').update(data).digest('hex')
    await this.request(`/api/blobs/${sha256}`, {
      method: 'PUT',
      // The app records dimensions but lays images out without them; 0 is
      // what the server stores for "unknown".
      headers: { 'content-type': mime },
      body: new Uint8Array(data),
    })
    return sha256
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, init)
    } catch (err) {
      throw new Error(`eidet is not reachable at ${this.base}: ${String(err)}`, { cause: err })
    }
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`eidet answered ${response.status} for ${path}: ${body}`)
    }
    return (await response.json()) as T
  }
}

/** The mirror is last-write-wins on `updatedAt`, the same rule the server keeps. */
function keepNewer<Row extends { id: string; updatedAt: number }>(
  rows: Map<string, Row>,
  row: Row,
) {
  const held = rows.get(row.id)
  if (!held || held.updatedAt <= row.updatedAt) rows.set(row.id, row)
}

/**
 * A write's `updatedAt`. The server keeps whichever copy is newer and drops
 * the other without a word, so an edit stamped behind the row it replaces —
 * written by a phone whose clock runs fast — would vanish. Always land after it.
 */
export function stamp(existing?: { updatedAt: number }): number {
  return Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1)
}
