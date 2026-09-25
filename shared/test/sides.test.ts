import { describe, expect, it } from 'vitest'
import { alignSidesToDeck } from '../src/sides.ts'
import { card, deck, field, kanji, side } from './factory.ts'

let n = 0
const newId = () => `new-${n++}`

describe('alignSidesToDeck', () => {
  it('returns the card itself when it already has a slot per field', () => {
    const c = kanji('k1')
    expect(alignSidesToDeck(deck(), c, newId)).toBe(c)
  })

  it('adds a blank slot for a field the deck gained after the card was made', () => {
    const d = deck({ fields: [...deck().fields, field('f-note', 'note', false)] })
    const out = alignSidesToDeck(d, kanji('k1'), newId)
    expect(out.sides.map((s) => s.fieldId)).toEqual(['f-glyph', 'f-read', 'f-mean', 'f-note'])
    expect(out.sides[3]).toMatchObject({ value: '', kind: 'text', label: null, tested: null })
  })

  it("follows the deck's field order and keeps a side whose field was removed", () => {
    const d = deck({ fields: [field('f-mean', 'meaning'), field('f-glyph', 'glyph')] })
    const out = alignSidesToDeck(d, kanji('k1'), newId)
    expect(out.sides.map((s) => s.id)).toEqual(['k1-mean', 'k1-glyph', 'k1-read'])
  })

  it('leaves a freeform card alone', () => {
    const c = card('c1', [side('a', 'x')])
    expect(alignSidesToDeck(deck({ mode: 'freeform', fields: [] }), c, newId)).toBe(c)
  })
})
