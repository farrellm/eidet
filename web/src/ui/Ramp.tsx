/**
 * The cyanometer ramp. See DESIGN.md §3.
 *
 * A side's recall probability, read off a graded blue scale. This is the only
 * place colour carries meaning, and the marks never carry it alone — every ramp
 * in the interface sits beside a label or a position saying the same thing, so
 * the deliberately low-contrast "faded" end stays readable as information.
 */
import type { Memory } from '@eidet/shared'
import { retrievability } from '@eidet/shared'

export type RampStep = 0 | 1 | 2 | 3

/**
 * The ramp's four bands, by upper edge of R. The one definition: every mark and
 * the home screen's histogram axis read their thresholds from here.
 */
export const RAMP_BANDS: readonly { max: number; step: RampStep }[] = [
  { max: 0.7, step: 0 },
  { max: 0.85, step: 1 },
  { max: 0.95, step: 2 },
  { max: 1, step: 3 },
]

export function rampStep(r: number): RampStep {
  for (const band of RAMP_BANDS) if (r < band.max) return band.step
  return 3
}

export function rampColor(step: RampStep): string {
  return `var(--r-${step})`
}

/** Plain-language recall strength, for the accessible name beside every ramp. */
export function rampWord(step: RampStep): string {
  return ['faded', 'weakening', 'holding', 'fresh'][step]!
}

export function memoryRamp(memory: Memory | undefined, now: number): RampStep {
  if (!memory) return 0
  return rampStep(retrievability(memory, now))
}

/**
 * Four ticks, filled up to the side's current strength. Reads as a small level
 * gauge rather than a progress bar — it is a measurement, not a task.
 */
export function Ramp({ step, label }: { step: RampStep; label?: string }) {
  const title = label ?? `recall ${rampWord(step)}`
  return (
    <span className="ramp" role="img" aria-label={title}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="ramp__tick"
          style={{ background: i <= step ? rampColor(step) : 'var(--hairline)' }}
        />
      ))}
    </span>
  )
}
