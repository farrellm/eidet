/**
 * The home screen's hero. See DESIGN.md §3, §4.
 *
 * Every side placed on the schedule horizon: how much is due now, how much
 * lands this week, how much is parked a year out. The shape of the collection,
 * not a count of it.
 *
 * Form: a distribution, so a histogram. Bins are log-spaced because intervals
 * are — a linear axis would pile a healthy collection into one bar. Position
 * and colour encode the same variable, which is deliberate: the redundancy is
 * what keeps it readable without colour.
 */
import { useState } from 'react'
import type { Memory } from '@eidet/shared'
import { rampColor, type RampStep } from './Ramp.tsx'

const HOUR = 3_600_000
const DAY = 24 * HOUR

interface Bin {
  /** Upper edge, in ms from now. `Infinity` for the last bin. */
  until: number
  label: string
  /** Ramp step used to paint the bar; `null` means the due band. */
  step: RampStep | null
  tick?: string
}

const BINS: Bin[] = [
  { until: 0, label: 'due now', step: null, tick: 'now' },
  { until: DAY, label: 'later today', step: 0 },
  { until: 3 * DAY, label: 'in 1–3 days', step: 0 },
  { until: 7 * DAY, label: 'this week', step: 1, tick: 'week' },
  { until: 14 * DAY, label: 'in 1–2 weeks', step: 1 },
  { until: 30 * DAY, label: 'this month', step: 2, tick: 'month' },
  { until: 90 * DAY, label: 'in 1–3 months', step: 2 },
  { until: 365 * DAY, label: 'this year', step: 3, tick: 'year' },
  { until: Infinity, label: 'beyond a year', step: 3 },
]

export function Cyanometer({ memories, now }: { memories: Memory[]; now: number }) {
  const [reading, setReading] = useState<number | null>(null)

  const counts = new Array(BINS.length).fill(0) as number[]
  for (const m of memories) {
    const delta = m.due - now
    const i = BINS.findIndex((b) => delta <= b.until)
    counts[i === -1 ? BINS.length - 1 : i]!++
  }
  const peak = Math.max(...counts, 1)
  const total = memories.length
  if (total === 0) return null

  const shown = reading === null ? null : { bin: BINS[reading]!, count: counts[reading]! }

  return (
    <figure className="cyano">
      <div className="cyano__plot">
        {BINS.map((bin, i) => {
          const count = counts[i]!
          return (
            <button
              key={i}
              type="button"
              className={`cyano__bar${reading === i ? ' cyano__bar--read' : ''}`}
              onPointerEnter={() => setReading(i)}
              onPointerLeave={() => setReading(null)}
              onClick={() => setReading(reading === i ? null : i)}
              aria-label={`${count} ${count === 1 ? 'side' : 'sides'} ${bin.label}`}
            >
              {count > 0 ? (
                <span
                  className="cyano__fill"
                  style={{
                    height: `${(count / peak) * 100}%`,
                    background: bin.step === null ? 'var(--brass)' : rampColor(bin.step),
                  }}
                />
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="cyano__axis" aria-hidden="true">
        {BINS.map((bin, i) => (
          <span key={i} className="cyano__tick">
            {bin.tick ?? ''}
          </span>
        ))}
      </div>

      {/* The readout stands in for a tooltip: this is a touch screen. */}
      <figcaption className="cyano__readout">
        {shown
          ? `${shown.count} ${shown.count === 1 ? 'side' : 'sides'} ${shown.bin.label}`
          : `${total} sides scheduled`}
      </figcaption>
    </figure>
  )
}
