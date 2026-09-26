/**
 * The tools: reading and writing decks and cards. See DESIGN.md §1, §5, §6.
 *
 * Each write mirrors its counterpart in `web/src/db/mutations.ts` and the deck
 * settings screen, so a deck or card made here is indistinguishable from one
 * made on the phone. Every tool catches the mirror up first, so it acts on what
 * the server holds now rather than on what it held at the last call.
 */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  type Card,
  type Deck,
  type DeckField,
  type Side,
  type SideKind,
  alignSidesToDeck,
  sideFilled,
  sideLabel,
  sideTested,
} from '@eidet/shared'
import { type EidetClient, stamp } from './client.ts'

/** The server's limit on one image (`MAX_BLOB_BYTES`), restated rather than imported. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const newId = () => randomUUID()

// ---------------------------------------------------------------- schemas

const content = z
  .union([
    z.string(),
    z.object({ text: z.string() }),
    z.object({ imagePath: z.string().describe('Absolute path to a png, jpeg, webp or gif.') }),
  ])
  .describe("A side's content: text (a plain string, or {text}), or {imagePath} for an image.")

type Content = z.infer<typeof content>

const fieldInput = z.object({
  id: z.string().optional().describe('An existing field to keep. Omit for a new field.'),
  name: z.string(),
  kind: z.enum(['text', 'image']).optional().describe('New fields only; defaults to text.'),
  tested: z.boolean().optional().describe('Whether this field is asked; defaults to true.'),
})

const cuePreference = z
  .string()
  .optional()
  .describe('A tested field name or id to always prompt from, or "auto" (the default).')

const values = z
  .record(z.string(), content)
  .describe('Content by field name (or field id). Schema decks only.')

const freeformSide = z.object({
  label: z.string(),
  value: content,
  tested: z.boolean().optional().describe('Defaults to true.'),
})

const freeformSidePatch = z.object({
  id: z.string().optional().describe('An existing side to keep, with its schedule. Omit for new.'),
  label: z.string().optional(),
  value: content.optional(),
  tested: z.boolean().optional(),
})

// ---------------------------------------------------------------- views

/** A card as a caller sees it: every side resolved against its deck. */
function viewCard(deck: Deck, card: Card) {
  return {
    id: card.id,
    deckId: card.deckId,
    sides: card.sides.map((side) => ({
      id: side.id,
      label: sideLabel(deck, side),
      kind: side.kind,
      value: side.value,
      tested: sideTested(deck, side),
    })),
  }
}

function viewDeck(deck: Deck, cardCount: number) {
  return {
    id: deck.id,
    name: deck.name,
    mode: deck.mode,
    fields: deck.fields,
    cuePreference: deck.cuePreference,
    cards: cardCount,
  }
}

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
})

// ---------------------------------------------------------------- lookups

function liveDeck(client: EidetClient, id: string): Deck {
  const deck = client.decks.get(id)
  if (!deck || deck.deletedAt !== null) throw new Error(`No deck ${id}.`)
  return deck
}

function liveCard(client: EidetClient, id: string): Card {
  const card = client.cards.get(id)
  if (!card || card.deletedAt !== null) throw new Error(`No card ${id}.`)
  return card
}

function liveCards(client: EidetClient, deckId: string): Card[] {
  return [...client.cards.values()].filter((c) => c.deckId === deckId && c.deletedAt === null)
}

function liveDecks(client: EidetClient): Deck[] {
  return [...client.decks.values()]
    .filter((d) => d.deletedAt === null)
    .sort((a, b) => a.order - b.order)
}

/** A schema field by id, or by name — exact first, then ignoring case. */
function findField(deck: Deck, key: string): DeckField {
  const lower = key.toLowerCase()
  const field =
    deck.fields.find((f) => f.id === key) ??
    deck.fields.find((f) => f.name === key) ??
    deck.fields.find((f) => f.name.toLowerCase() === lower)
  if (!field) {
    const names = deck.fields.map((f) => f.name).join(', ')
    throw new Error(`Deck "${deck.name}" has no field "${key}" (fields: ${names}).`)
  }
  return field
}

// ---------------------------------------------------------------- content

/** Content as a side's `kind` and `value`, uploading an image first. */
async function resolveContent(client: EidetClient, input: Content) {
  if (typeof input === 'string') return { kind: 'text' as SideKind, value: input }
  if ('text' in input) return { kind: 'text' as SideKind, value: input.text }

  const path = input.imagePath
  const mime = IMAGE_TYPES[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${path}: not a png, jpeg, webp or gif.`)
  const { size } = await stat(path)
  if (size > MAX_IMAGE_BYTES) throw new Error(`${path}: larger than 8 MB.`)
  // Uploaded before the card that names it is pushed, so no device ever pulls
  // a card whose image the server does not have.
  return { kind: 'image' as SideKind, value: await client.putBlob(await readFile(path), mime) }
}

/** Fill a schema card's slots from `values`, keyed by field name or id. */
async function fillSlots(
  client: EidetClient,
  deck: Deck,
  card: Card,
  input: Record<string, Content>,
): Promise<Card> {
  const aligned = alignSidesToDeck(deck, card, newId)
  const sides = [...aligned.sides]
  for (const [key, value] of Object.entries(input)) {
    const field = findField(deck, key)
    const { kind, value: resolved } = await resolveContent(client, value)
    if (kind !== field.kind) {
      throw new Error(`Field "${field.name}" holds ${field.kind}, not ${kind}.`)
    }
    const at = sides.findIndex((s) => s.fieldId === field.id)
    sides[at] = { ...sides[at]!, value: resolved }
  }
  return { ...aligned, sides }
}

async function freeformSides(
  client: EidetClient,
  input: z.infer<typeof freeformSide>[],
): Promise<Side[]> {
  const sides: Side[] = []
  for (const side of input) {
    const { kind, value } = await resolveContent(client, side.value)
    sides.push({
      id: newId(),
      fieldId: null,
      label: side.label,
      kind,
      value,
      tested: side.tested ?? true,
    })
  }
  return sides
}

/**
 * Freeform sides from a full replacement list. A listed id keeps that side —
 * and with it the side's schedule, since memory is keyed by side id — so an
 * edit that only rewords a side does not start it over.
 */
async function patchFreeformSides(
  client: EidetClient,
  card: Card,
  input: z.infer<typeof freeformSidePatch>[],
): Promise<Side[]> {
  const byId = new Map(card.sides.map((s) => [s.id, s]))
  const sides: Side[] = []
  for (const patch of input) {
    const resolved = patch.value === undefined ? null : await resolveContent(client, patch.value)
    if (patch.id !== undefined) {
      const held = byId.get(patch.id)
      if (!held) throw new Error(`Card ${card.id} has no side ${patch.id}.`)
      sides.push({
        ...held,
        label: patch.label ?? held.label,
        tested: patch.tested ?? held.tested,
        ...(resolved ?? {}),
      })
    } else {
      if (patch.label === undefined || resolved === null) {
        throw new Error('A new side needs a label and a value.')
      }
      sides.push({
        id: newId(),
        fieldId: null,
        label: patch.label,
        tested: patch.tested ?? true,
        ...resolved,
      })
    }
  }
  return sides
}

/** A card nobody will ever be asked about is almost certainly a mistake. */
function assertAskable(deck: Deck, card: Card) {
  if (!card.sides.some((s) => sideFilled(s) && sideTested(deck, s))) {
    throw new Error('A card needs at least one filled, tested side, or it is never reviewed.')
  }
}

// ---------------------------------------------------------------- decks

/** A deck's field list from a full replacement list, as the settings screen saves it. */
function nextFields(existing: DeckField[], input: z.infer<typeof fieldInput>[]): DeckField[] {
  const byId = new Map(existing.map((f) => [f.id, f]))
  const fields = input
    .map((f): DeckField => {
      const name = f.name.trim()
      if (f.id === undefined) {
        return { id: newId(), name, kind: f.kind ?? 'text', tested: f.tested ?? true }
      }
      const held = byId.get(f.id)
      if (!held) throw new Error(`No field ${f.id} on this deck.`)
      // A field's kind shapes every side filed under it; changing it would
      // strand their content in the wrong kind.
      if (f.kind !== undefined && f.kind !== held.kind) {
        throw new Error(`Field "${held.name}" is ${held.kind}; a field's kind cannot change.`)
      }
      return { ...held, name, tested: f.tested ?? held.tested }
    })
    .filter((f) => f.name.length > 0)
  if (fields.length < 2) throw new Error('A schema deck needs at least two named fields.')
  return fields
}

/**
 * A pinned cue only means something for a schema deck, and only while it
 * names a tested field; anything else falls back to auto, as in the settings screen.
 */
function pinCue(mode: Deck['mode'], fields: DeckField[], wanted: string | undefined) {
  if (wanted === undefined || wanted === 'auto') return 'auto'
  if (mode !== 'schema') throw new Error('Only a schema deck can pin a cue field.')
  const lower = wanted.toLowerCase()
  const field = fields.find((f) => f.id === wanted || f.name.toLowerCase() === lower)
  if (!field) throw new Error(`No field "${wanted}" to pin as the cue.`)
  if (!field.tested)
    throw new Error(`Field "${field.name}" is not tested, so it cannot be the cue.`)
  return field.id
}

// ---------------------------------------------------------------- tools

export function registerTools(server: McpServer, client: EidetClient) {
  /** Every tool starts from what the server holds now. */
  const fresh =
    <Args>(fn: (args: Args) => unknown) =>
    async (args: Args): Promise<CallToolResult> => {
      await client.refresh()
      return json(await fn(args))
    }

  server.registerTool(
    'list_decks',
    {
      description:
        'List the decks, in home-screen order, with their fields and live card counts. ' +
        'A schema deck has named fields and one side per field on every card; ' +
        'a freeform deck lets each card carry its own labelled sides.',
      annotations: { readOnlyHint: true },
    },
    fresh(() => liveDecks(client).map((d) => viewDeck(d, liveCards(client, d.id).length))),
  )

  server.registerTool(
    'list_cards',
    {
      description: "List a deck's cards, with each side's label, content and whether it is tested.",
      inputSchema: {
        deckId: z.string(),
        query: z.string().optional().describe('Only cards with a side containing this text.'),
        limit: z.number().int().positive().optional().describe('Defaults to 100.'),
        offset: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    fresh(({ deckId, query, limit = 100, offset = 0 }) => {
      const deck = liveDeck(client, deckId)
      const needle = query?.toLowerCase()
      const cards = liveCards(client, deckId).filter(
        (c) => !needle || c.sides.some((s) => s.value.toLowerCase().includes(needle)),
      )
      return {
        total: cards.length,
        cards: cards.slice(offset, offset + limit).map((c) => viewCard(deck, c)),
      }
    }),
  )

  server.registerTool(
    'get_card',
    {
      description: 'One card, with its sides resolved against its deck.',
      inputSchema: { cardId: z.string() },
      annotations: { readOnlyHint: true },
    },
    fresh(({ cardId }) => {
      const card = liveCard(client, cardId)
      return viewCard(liveDeck(client, card.deckId), card)
    }),
  )

  server.registerTool(
    'create_deck',
    {
      description:
        'Create a deck. The mode is fixed for good once created. A schema deck needs at ' +
        'least two fields; a freeform deck takes none.',
      inputSchema: {
        name: z.string(),
        mode: z.enum(['schema', 'freeform']),
        fields: z.array(fieldInput.omit({ id: true })).optional(),
        cuePreference,
      },
    },
    fresh(async ({ name, mode, fields = [], cuePreference }) => {
      if (mode === 'freeform' && fields.length > 0) {
        throw new Error('A freeform deck has no fields; each card labels its own sides.')
      }
      const deckFields = mode === 'schema' ? nextFields([], fields) : []
      const now = stamp()
      const deck: Deck = {
        id: newId(),
        name: name.trim() || 'Untitled deck',
        mode,
        fields: deckFields,
        cuePreference: pinCue(mode, deckFields, cuePreference),
        order: liveDecks(client).length,
        updatedAt: now,
        deletedAt: null,
        seq: 0,
      }
      await client.push({ decks: [deck] })
      return viewDeck(deck, 0)
    }),
  )

  server.registerTool(
    'update_deck',
    {
      description:
        'Rename a deck, change its fields or its cue. `fields` is the full new list: pass ' +
        "an existing field's id to keep it (renaming or toggling `tested`), omit the id " +
        'for a new field, and leave a field out to remove it. Removing a field keeps its ' +
        "content on the cards but stops it being asked. A deck's mode cannot change.",
      inputSchema: {
        deckId: z.string(),
        name: z.string().optional(),
        fields: z.array(fieldInput).optional().describe('Schema decks only.'),
        cuePreference,
      },
    },
    fresh(async ({ deckId, name, fields, cuePreference }) => {
      const deck = liveDeck(client, deckId)
      if (fields && deck.mode !== 'schema') throw new Error('A freeform deck has no fields.')
      const deckFields = fields ? nextFields(deck.fields, fields) : deck.fields
      // Keep a pinned cue unless it is being changed or its field has gone.
      const wanted =
        cuePreference ??
        (deckFields.some((f) => f.id === deck.cuePreference && f.tested)
          ? deck.cuePreference
          : 'auto')
      const next: Deck = {
        ...deck,
        name: name === undefined ? deck.name : name.trim() || deck.name,
        fields: deckFields,
        cuePreference: pinCue(deck.mode, deckFields, wanted),
        updatedAt: stamp(deck),
      }
      // The cards are left as they are: each device reconciles their memories
      // against the new fields when it pulls the deck, and `alignSidesToDeck`
      // gives a card its new slots the next time it is edited.
      await client.push({ decks: [next] })
      return viewDeck(next, liveCards(client, deckId).length)
    }),
  )

  server.registerTool(
    'delete_deck',
    {
      description: 'Delete a deck and every card in it, on every device.',
      inputSchema: { deckId: z.string() },
      annotations: { destructiveHint: true },
    },
    fresh(async ({ deckId }) => {
      const deck = liveDeck(client, deckId)
      const cards = liveCards(client, deckId)
      const now = stamp(deck)
      // The cards go with it, as on the phone: a deck's tombstone alone would
      // leave their memories counted on the home screen.
      await client.push({
        decks: [{ ...deck, deletedAt: now, updatedAt: now }],
        cards: cards.map((c) => {
          const at = stamp(c)
          return { ...c, deletedAt: at, updatedAt: at }
        }),
      })
      return { deleted: deckId, cards: cards.length }
    }),
  )

  server.registerTool(
    'create_cards',
    {
      description:
        'Add cards to a deck, in one batch. In a schema deck give each card `values` by ' +
        'field name; fields left out stay empty. In a freeform deck give each card its ' +
        '`sides`. Every card needs at least one filled, tested side. New sides are due at once.',
      inputSchema: {
        deckId: z.string(),
        cards: z
          .array(z.object({ values: values.optional(), sides: z.array(freeformSide).optional() }))
          .min(1),
      },
    },
    fresh(async ({ deckId, cards }) => {
      const deck = liveDeck(client, deckId)
      const built: Card[] = []
      for (const [i, input] of cards.entries()) {
        const now = stamp()
        const blank: Card = {
          id: newId(),
          deckId,
          sides: [],
          updatedAt: now,
          deletedAt: null,
          seq: 0,
        }
        let card: Card
        if (deck.mode === 'schema') {
          if (input.sides)
            throw new Error(`Card ${i}: a schema deck takes \`values\`, not \`sides\`.`)
          card = await fillSlots(client, deck, blank, input.values ?? {})
        } else {
          if (input.values)
            throw new Error(`Card ${i}: a freeform deck takes \`sides\`, not \`values\`.`)
          card = { ...blank, sides: await freeformSides(client, input.sides ?? []) }
        }
        try {
          assertAskable(deck, card)
        } catch (err) {
          throw new Error(`Card ${i}: ${(err as Error).message}`, { cause: err })
        }
        built.push(card)
      }
      await client.push({ cards: built })
      return built.map((c) => viewCard(deck, c))
    }),
  )

  server.registerTool(
    'update_card',
    {
      description:
        "Edit a card's content. In a schema deck, `values` sets only the fields named. " +
        "In a freeform deck, `sides` is the full new list: pass a side's id to keep it " +
        '(and its schedule), omit the id for a new side, leave a side out to remove it. ' +
        'Rewording a side does not reset its schedule. A card cannot move between decks.',
      inputSchema: {
        cardId: z.string(),
        values: values.optional(),
        sides: z.array(freeformSidePatch).optional().describe('Freeform decks only.'),
      },
    },
    fresh(async ({ cardId, values, sides }) => {
      const card = liveCard(client, cardId)
      const deck = liveDeck(client, card.deckId)
      let next: Card
      if (deck.mode === 'schema') {
        if (sides) throw new Error('A schema deck takes `values`, not `sides`.')
        next = await fillSlots(client, deck, card, values ?? {})
      } else {
        if (values) throw new Error('A freeform deck takes `sides`, not `values`.')
        next = sides ? { ...card, sides: await patchFreeformSides(client, card, sides) } : card
      }
      next = { ...next, updatedAt: stamp(card) }
      await client.push({ cards: [next] })
      return viewCard(deck, next)
    }),
  )

  server.registerTool(
    'delete_card',
    {
      description: 'Delete a card, on every device.',
      inputSchema: { cardId: z.string() },
      annotations: { destructiveHint: true },
    },
    fresh(async ({ cardId }) => {
      const card = liveCard(client, cardId)
      const now = stamp(card)
      await client.push({ cards: [{ ...card, deletedAt: now, updatedAt: now }] })
      return { deleted: cardId }
    }),
  )
}
