/**
 * One revealed side. See DESIGN.md §1, §4.
 *
 * The whole row is the tap target — tapping marks it missed, which dims it and
 * gives it a brass left rule. No small icons: this is a thumb on a phone.
 * Untested sides come along as context and carry no ramp and no grade.
 */
import { type Deck, type Memory, type Side, sideLabel } from '@eidet/shared'
import { Ramp, memoryRamp, rampWord } from './Ramp.tsx'
import { SideValue } from './SideValue.tsx'

export function SideRow({
  deck,
  side,
  memory,
  index,
  missed,
  context = false,
  onToggle,
}: {
  deck: Deck
  side: Side
  memory: Memory | undefined
  /** Position in the reveal, driving the 40ms stagger. */
  index: number
  missed: boolean
  context?: boolean
  onToggle: () => void
}) {
  const now = Date.now()
  const step = memoryRamp(memory, now)

  return (
    <button
      type="button"
      className={`row${missed ? ' row--missed' : ''}${context ? ' row--context' : ''}`}
      style={{ '--i': index } as React.CSSProperties}
      onClick={onToggle}
      aria-pressed={missed}
      aria-label={`${sideLabel(deck, side)}${missed ? ', missed' : ''}. Tap to mark ${missed ? 'known' : 'missed'}.`}
    >
      <span className="row__head">
        <span className="label">{sideLabel(deck, side)}</span>
        {context ? (
          <span className="label row__note">not due</span>
        ) : (
          <Ramp step={step} label={`recall ${rampWord(step)}`} />
        )}
      </span>
      <span className="content row__value">
        <SideValue side={side} />
      </span>
    </button>
  )
}
