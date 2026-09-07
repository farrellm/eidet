/**
 * The home screen's hero. See DESIGN.md §3, §4.
 *
 * Every side in the collection placed along the retrievability ramp: the shape
 * of your memory, not a count of it. A bright mass on the right, a fringe
 * sliding left into the brass band.
 *
 * Form: a distribution, so a histogram — a sorted strip of one mark per side
 * would collapse into a four-segment proportion bar, which is the generic
 * answer this design refuses.
 *
 * Axis: R, but *banded* rather than linear. Each of the ramp's four bands gets
 * an equal share of the width and is subdivided evenly inside it. A linear R
 * axis would be useless here: FSRS schedules a side for the moment R reaches
 * the retention target, so every side that is not yet due is crowded into the
 * top tenth of the scale. Giving each band equal width puts resolution where
 * the collection actually lives, and lands the axis ticks exactly where the
 * colour changes — the axis and the ramp say the same thing in two channels.
 *
 * Height: the square root of the count. A healthy collection is massively
 * skewed — every side reviewed in the last few days sits at R near 1, so a
 * linear scale gives the rightmost bin the full height and squashes the whole
 * left-hand tail, which is the half you actually need to see, into a few
 * pixels. Square root keeps the ordering and the zero, and exact counts live
 * in the readout, which is where a chart's precision belongs.
 *
 * Colour: the ramp, encoding the same R the position does. The redundancy is
 * deliberate (§3) — it keeps the chart readable without colour. Brass is not a
 * bar colour at all: it is a rule beneath the axis marking the region that is
 * due, so it stays one contiguous mark and no bar has to be part-brass.
 */
import { useState } from 'react'
import type { Memory } from '@eidet/shared'
import { retrievability } from '@eidet/shared'
import { rampColor, rampWord, type RampStep } from './Ramp.tsx'

/** Upper edge and ramp step of each band, matching `rampStep` in Ramp.tsx. */
const BANDS: { max: number; step: RampStep }[] = [
  { max: 0.7, step: 0 },
  { max: 0.85, step: 1 },
  { max: 0.95, step: 2 },
  { max: 1, step: 3 },
]
/** Bins per band. Twenty marks total reads as a distribution; four reads as a bar. */
const PER_BAND = 5

interface Bin {
  from: number
  to: number
  step: RampStep
}

const BINS: Bin[] = BANDS.flatMap(({ max, step }, b) => {
  const min = b === 0 ? 0 : BANDS[b - 1]!.max
  const width = (max - min) / PER_BAND
  return Array.from({ length: PER_BAND }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    step,
  }))
})

/** Which bin an R falls in. The last bin is closed so R = 1 has a home. */
function binOf(r: number): number {
  for (let i = 0; i < BINS.length; i++) if (r < BINS[i]!.to) return i
  return BINS.length - 1
}

/**
 * Where the due region ends, as a fraction of the plot's width. A side falls
 * due when R reaches the retention target, so that target is the boundary —
 * a fixed, principled position rather than one that jitters with the data.
 */
function dueFraction(target: number): number {
  const i = binOf(target)
  const bin = BINS[i]!
  const within = (target - bin.from) / (bin.to - bin.from)
  return (i + within) / BINS.length
}

export function Cyanometer({
  memories,
  now,
  requestRetention,
}: {
  memories: Memory[]
  now: number
  requestRetention: number
}) {
  const [reading, setReading] = useState<number | null>(null)

  const counts = new Array(BINS.length).fill(0) as number[]
  for (const m of memories) counts[binOf(retrievability(m, now))]!++

  const peak = Math.max(...counts, 1)
  const total = memories.length
  const due = memories.filter((m) => m.due <= now).length
  if (total === 0) return null

  const sides = (n: number) => `${n} ${n === 1 ? 'side' : 'sides'}`

  return (
    <figure className="cyano">
      <div className="cyano__plot">
        {BINS.map((bin, i) => {
          const count = counts[i]!
          return (
            <button
              key={i}
              type="button"
              className="cyano__bar"
              onPointerEnter={() => setReading(i)}
              onPointerLeave={() => setReading(null)}
              onClick={() => setReading(reading === i ? null : i)}
              aria-label={`${sides(count)}, recall ${rampWord(bin.step)}`}
            >
              {count > 0 ? (
                <span
                  className="cyano__fill"
                  style={{
                    height: `${Math.sqrt(count / peak) * 100}%`,
                    background: rampColor(bin.step),
                  }}
                />
              ) : null}
            </button>
          )
        })}
      </div>

      {/* The baseline, and the brass rule marking how much of it is due. */}
      <div className="cyano__scale">
        {due > 0 ? (
          <span
            className="cyano__due"
            style={{ width: `${dueFraction(requestRetention) * 100}%` }}
          />
        ) : null}
      </div>

      <div className="cyano__axis" aria-hidden="true">
        {BANDS.map((band) => (
          <span key={band.step} className="cyano__tick">
            {rampWord(band.step)}
          </span>
        ))}
      </div>

      {/* The readout stands in for a tooltip: this is a touch screen. */}
      <figcaption className="cyano__readout">
        {reading === null
          ? due > 0
            ? `${sides(total)}. ${due} due now.`
            : `${sides(total)}. Nothing due.`
          : `${sides(counts[reading]!)}, recall ${rampWord(BINS[reading]!.step)}.`}
      </figcaption>
    </figure>
  )
}
