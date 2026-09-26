/**
 * The tools, driven through a real MCP client against the real HTTP handler.
 * What matters is what lands on the server: rows shaped exactly as the phone
 * would have written them, since the phone is what schedules them.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Card, Deck, PullResponse } from '@eidet/shared'
import { createHandler } from '@eidet/server/src/app.ts'
import { BlobStore } from '@eidet/server/src/blobs.ts'
import { openDb } from '@eidet/server/src/db.ts'
import { EidetClient } from '../src/client.ts'
import { registerTools } from '../src/tools.ts'

let server: Server
let base: string
let dir: string
let client: Client

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eidet-mcp-'))
  const db = openDb(':memory:')
  const handle = createHandler({ db, blobs: new BlobStore(db, join(dir, 'blobs')), webRoot: dir })
  server = createServer((req, res) => void handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const mcp = new McpServer({ name: 'eidet', version: 'test' })
  registerTools(mcp, new EidetClient(base))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.connect(serverSide)
  client = new Client({ name: 'test', version: 'test' })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

interface Result {
  isError?: boolean
  content: { type: string; text: string }[]
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as Result
  if (result.isError) throw new Error(result.content[0]!.text)
  return JSON.parse(result.content[0]!.text) as T
}

async function failure(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as Result
  expect(result.isError).toBe(true)
  return result.content[0]!.text
}

/** What the server holds, as a fresh device would pull it. */
async function pulled(): Promise<PullResponse> {
  return (await fetch(`${base}/api/changes?since=0`)).json() as Promise<PullResponse>
}

async function pushDirect(changes: { decks?: Deck[]; cards?: Card[] }) {
  await fetch(`${base}/api/changes`, { method: 'POST', body: JSON.stringify(changes) })
}

interface DeckView {
  id: string
  fields: { id: string; name: string }[]
  cuePreference: string
  cards: number
}
interface CardView {
  id: string
  sides: { id: string; label: string; value: string; tested: boolean }[]
}

const vocab = () =>
  call<DeckView>('create_deck', {
    name: 'Vocab',
    mode: 'schema',
    fields: [{ name: 'Word' }, { name: 'Meaning' }, { name: 'Note', tested: false }],
  })

describe('schema decks', () => {
  it('files values under their fields, one side per field in field order', async () => {
    const deck = await vocab()
    const [made] = await call<CardView[]>('create_cards', {
      deckId: deck.id,
      cards: [{ values: { word: 'eidetic', Meaning: 'vivid recall' } }],
    })

    expect(made!.sides.map((s) => [s.label, s.value, s.tested])).toEqual([
      ['Word', 'eidetic', true],
      ['Meaning', 'vivid recall', true],
      ['Note', '', false],
    ])
    const { cards } = await pulled()
    expect(cards).toHaveLength(1)
    expect(cards[0]!.sides.map((s) => s.fieldId)).toEqual(deck.fields.map((f) => f.id))
    // Schema sides take their label and tested flag from the deck.
    expect(cards[0]!.sides.every((s) => s.label === null && s.tested === null)).toBe(true)
  })

  it('refuses an unknown field and a card with nothing to ask', async () => {
    const deck = await vocab()
    expect(
      await failure('create_cards', { deckId: deck.id, cards: [{ values: { Colour: 'x' } }] }),
    ).toMatch(/no field "Colour"/)
    expect(
      await failure('create_cards', { deckId: deck.id, cards: [{ values: { Note: 'x' } }] }),
    ).toMatch(/filled, tested side/)
    expect((await pulled()).cards).toHaveLength(0)
  })

  it('gives an existing card a slot for a field added later', async () => {
    const deck = await vocab()
    const [card] = await call<CardView[]>('create_cards', {
      deckId: deck.id,
      cards: [{ values: { Word: 'a', Meaning: 'b' } }],
    })
    const updated = await call<DeckView>('update_deck', {
      deckId: deck.id,
      mode: 'freeform',
      fields: [...deck.fields.map((f) => ({ id: f.id, name: f.name })), { name: 'Example' }],
    })
    expect(updated.fields).toHaveLength(4)
    const deckRow = (await pulled()).decks[0]!
    expect(deckRow.mode).toBe('schema')

    const edited = await call<CardView>('update_card', {
      cardId: card!.id,
      values: { Example: 'an example' },
    })
    expect(edited.sides.find((s) => s.label === 'Example')?.value).toBe('an example')
    expect(edited.sides.find((s) => s.label === 'Word')?.id).toBe(card!.sides[0]!.id)
  })

  it('drops a pinned cue whose field is removed', async () => {
    const deck = await call<DeckView>('create_deck', {
      name: 'Pinned',
      mode: 'schema',
      fields: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      cuePreference: 'A',
    })
    expect(deck.cuePreference).toBe(deck.fields[0]!.id)
    const next = await call<DeckView>('update_deck', {
      deckId: deck.id,
      fields: deck.fields.slice(1).map((f) => ({ id: f.id, name: f.name })),
    })
    expect(next.cuePreference).toBe('auto')
  })
})

describe('freeform decks', () => {
  it('keeps a side listed by id, drops one left out, adds one without an id', async () => {
    const deck = await call<DeckView>('create_deck', { name: 'Loose', mode: 'freeform' })
    const [card] = await call<CardView[]>('create_cards', {
      deckId: deck.id,
      cards: [
        {
          sides: [
            { label: 'front', value: 'Q' },
            { label: 'back', value: { text: 'A' } },
          ],
        },
      ],
    })
    const [front, back] = card!.sides
    const edited = await call<CardView>('update_card', {
      cardId: card!.id,
      sides: [
        { id: front!.id, value: 'Q, reworded' },
        { label: 'hint', value: 'H', tested: false },
      ],
    })

    expect(edited.sides[0]).toEqual({ ...front, value: 'Q, reworded', kind: 'text' })
    expect(edited.sides.map((s) => s.id)).not.toContain(back!.id)
    expect(edited.sides[1]).toMatchObject({ label: 'hint', value: 'H', tested: false })
    const stored = (await pulled()).cards[0]!
    expect(stored.sides[1]).toMatchObject({ fieldId: null, label: 'hint', tested: false })
  })
})

describe('sync', () => {
  it('wins last-write-wins against a row stamped by a fast clock', async () => {
    const deck = await vocab()
    const future = Date.now() + 86_400_000
    const card: Card = {
      id: 'c1',
      deckId: deck.id,
      sides: [],
      updatedAt: future,
      deletedAt: null,
      seq: 0,
    }
    await pushDirect({ cards: [card] })

    await call('update_card', { cardId: 'c1', values: { Word: 'late' } })
    const stored = (await pulled()).cards.find((c) => c.id === 'c1')!
    expect(stored.updatedAt).toBeGreaterThan(future)
    expect(stored.sides[0]!.value).toBe('late')
  })

  it('sees what another device pushed since the last call', async () => {
    const deck = await vocab()
    const raw = (await pulled()).decks[0]!
    await pushDirect({
      decks: [{ ...raw, name: 'Renamed on the phone', updatedAt: raw.updatedAt + 1 }],
    })
    const [listed] = await call<(DeckView & { name: string })[]>('list_decks')
    expect(listed).toMatchObject({ id: deck.id, name: 'Renamed on the phone' })
  })

  it('deletes a deck together with its cards', async () => {
    const deck = await vocab()
    await call('create_cards', {
      deckId: deck.id,
      cards: [{ values: { Word: 'a' } }, { values: { Word: 'b' } }],
    })
    expect(await call('delete_deck', { deckId: deck.id })).toEqual({ deleted: deck.id, cards: 2 })
    const { decks, cards } = await pulled()
    expect(decks[0]!.deletedAt).not.toBeNull()
    expect(cards.every((c) => c.deletedAt !== null)).toBe(true)
    expect(await call('list_decks')).toEqual([])
  })
})

describe('images', () => {
  it('uploads the file and stores its digest as the side', async () => {
    const deck = await call<DeckView>('create_deck', { name: 'Pictures', mode: 'freeform' })
    const bytes = Buffer.from('not really a png, but the server only checks the digest')
    const path = join(dir, 'face.png')
    writeFileSync(path, bytes)

    const [card] = await call<CardView[]>('create_cards', {
      deckId: deck.id,
      cards: [
        {
          sides: [
            { label: 'face', value: { imagePath: path } },
            { label: 'name', value: 'Ada' },
          ],
        },
      ],
    })
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(card!.sides[0]).toMatchObject({ kind: 'image', value: sha })
    const blob = await fetch(`${base}/api/blobs/${sha}`)
    expect(blob.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes)
  })

  it('refuses a file that is not an image, and an image in a text field', async () => {
    const path = join(dir, 'notes.txt')
    writeFileSync(path, 'hello')
    const loose = await call<DeckView>('create_deck', { name: 'Loose', mode: 'freeform' })
    expect(
      await failure('create_cards', {
        deckId: loose.id,
        cards: [{ sides: [{ label: 'x', value: { imagePath: path } }] }],
      }),
    ).toMatch(/not a png/)

    const png = join(dir, 'x.png')
    writeFileSync(png, 'x')
    const deck = await vocab()
    expect(
      await failure('create_cards', {
        deckId: deck.id,
        cards: [{ values: { Word: { imagePath: png } } }],
      }),
    ).toMatch(/holds text, not image/)
  })
})
