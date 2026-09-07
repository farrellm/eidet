/**
 * The reveal, rendered. See DESIGN.md §10.
 *
 * Three properties the review loop rests on: every non-cue side is shown at
 * once, an untested side comes along as context with nothing to grade, and a
 * missed toggle survives a re-render — which is the component-level half of the
 * "reload returns to exactly the same state" guarantee.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CardBatch, Deck, Memory, Side } from '@eidet/shared'
import { newMemory } from '@eidet/shared'
import { CueCard } from './CueCard.tsx'
import { GradeBar } from './GradeBar.tsx'
import { SideRow } from './SideRow.tsx'

const T0 = Date.UTC(2026, 0, 1)

const deck: Deck = {
  id: 'd1',
  name: 'Kanji',
  mode: 'schema',
  fields: [
    { id: 'f-glyph', name: 'glyph', kind: 'text', tested: true },
    { id: 'f-read', name: 'reading', kind: 'text', tested: true },
    { id: 'f-mean', name: 'meaning', kind: 'text', tested: true },
    { id: 'f-note', name: 'mnemonic', kind: 'text', tested: false },
  ],
  cuePreference: 'auto',
  order: 0,
  updatedAt: T0,
  deletedAt: null,
  seq: 0,
}

const side = (fieldId: string, value: string): Side => ({
  id: `s-${fieldId}`,
  fieldId,
  label: null,
  kind: 'text',
  value,
  tested: null,
})

const sides = [
  side('f-glyph', '憂'),
  side('f-read', 'ユウ'),
  side('f-mean', 'grief, melancholy'),
  side('f-note', 'a heart under autumn'),
]

const batch: CardBatch = {
  cardId: 'c1',
  deckId: 'd1',
  cueSideId: 's-f-glyph',
  targetSideIds: ['s-f-read', 's-f-mean'],
  contextSideIds: ['s-f-note'],
}

const memoryFor = (sideId: string): Memory =>
  newMemory({ sideId, cardId: 'c1', deckId: 'd1' }, T0)

/** The reveal as `Review` composes it, without the router or the database. */
function Reveal({ missed = [] as string[] }) {
  const byId = new Map(sides.map((s) => [s.id, s]))
  const shown = [...batch.targetSideIds, ...batch.contextSideIds].map((id) => byId.get(id)!)
  return (
    <>
      <CueCard deck={deck} cue={byId.get(batch.cueSideId)!} docked hidden={0} />
      <div className="reveal">
        {shown.map((s, i) => (
          <SideRow
            key={s.id}
            deck={deck}
            side={s}
            memory={memoryFor(s.id)}
            index={i}
            context={i >= batch.targetSideIds.length}
            missed={missed.includes(s.id)}
            onToggle={() => {}}
          />
        ))}
      </div>
      <GradeBar onGrade={() => {}} />
    </>
  )
}

describe('the reveal', () => {
  it('shows every side of the card except the cue, all at once', () => {
    render(<Reveal />)
    expect(screen.getByText('ユウ')).toBeDefined()
    expect(screen.getByText('grief, melancholy')).toBeDefined()
    expect(screen.getByText('a heart under autumn')).toBeDefined()
    // The cue is present, but docked as the prompt rather than asked again.
    expect(screen.getByText('憂').closest('.cuecard')).not.toBeNull()
    expect(screen.getByText('憂').closest('.row')).toBeNull()
  })

  it('renders an untested side as context, with no strength and no grade of its own', () => {
    render(<Reveal />)
    const note = screen.getByText('a heart under autumn').closest('.row')!
    expect(note.className).toContain('row--context')
    expect(note.textContent).toContain('not due')
    // A graded row carries a ramp; a context row carries none.
    expect(note.querySelector('.ramp')).toBeNull()
    expect(
      screen.getByText('grief, melancholy').closest('.row')!.querySelector('.ramp'),
    ).not.toBeNull()

    // One grade bar for the card, not a control per row (§1: zero extra taps).
    expect(screen.getAllByRole('button', { name: /Again|Hard|Good|Easy/ })).toHaveLength(4)
  })

  it('keeps a missed toggle through a re-render', () => {
    const { rerender } = render(<Reveal missed={['s-f-mean']} />)
    const marked = () =>
      screen.getByText('grief, melancholy').closest('.row') as HTMLElement

    expect(marked().getAttribute('aria-pressed')).toBe('true')
    expect(marked().className).toContain('row--missed')

    rerender(<Reveal missed={['s-f-mean']} />)
    expect(marked().getAttribute('aria-pressed')).toBe('true')
    expect(marked().className).toContain('row--missed')

    // And the sides that were not tapped stay unmarked.
    expect(screen.getByText('ユウ').closest('.row')!.getAttribute('aria-pressed')).toBe('false')
  })
})
