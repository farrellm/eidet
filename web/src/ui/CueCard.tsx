/**
 * The cue side, and the one orchestrated moment in the app. See DESIGN.md §3.
 *
 * The card does not flip — it unfolds. The same element carries the cue through
 * both phases, so revealing docks it from the optical centre up to the top
 * strip rather than swapping one element for another. That distinction is the
 * whole point: the motion answers a tap and shows what changed, which is the
 * only kind of motion this design allows.
 *
 * Implemented as a FLIP: measure the specimen's box on every commit, and when
 * the phase changes, play the previous box forward into the new one. A shared
 * element is what makes this possible, so `CueCard` must stay mounted across
 * the phase change — hoisting it out of the phase branch in `Review` is not a
 * tidiness choice, it is the mechanism.
 */
import { useLayoutEffect, useRef } from 'react'
import { type Deck, type Side, sideLabel } from '@eidet/shared'
import { SideValue } from './SideValue.tsx'

const DURATION = 220
const EASE = 'cubic-bezier(.2,.7,.2,1)'

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function CueCard({
  deck,
  cue,
  docked,
  hidden,
}: {
  deck: Deck
  cue: Side
  docked: boolean
  /** How many sides are still folded away. Only shown before the reveal. */
  hidden: number
}) {
  const value = useRef<HTMLSpanElement>(null)
  const lastBox = useRef<DOMRect | null>(null)
  const lastDocked = useRef(docked)

  // No dependency list on purpose: this has to measure after *every* commit, so
  // that the box it remembers is always the one the next transition starts from.
  useLayoutEffect(() => {
    const el = value.current
    if (!el) return
    const box = el.getBoundingClientRect()
    const from = lastBox.current

    if (from && lastDocked.current !== docked && !prefersReducedMotion() && box.width > 0) {
      const scale = from.width / box.width
      el.animate(
        [
          {
            transform: `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${scale})`,
            transformOrigin: 'left top',
          },
          { transform: 'none', transformOrigin: 'left top' },
        ],
        { duration: DURATION, easing: EASE },
      )
    }

    lastBox.current = box
    lastDocked.current = docked
  })

  return (
    <div className={docked ? 'cuecard cuecard--docked' : 'cuecard'}>
      <div className="cuecard__inner">
        <span className="cuecard__value" ref={value}>
          <SideValue side={cue} inline={docked} />
        </span>
        <span className="label cuecard__label">{sideLabel(deck, cue)}</span>
      </div>
      {docked ? null : (
        <p className="fold">
          {hidden} {hidden === 1 ? 'side' : 'sides'} hidden
        </p>
      )}
    </div>
  )
}
