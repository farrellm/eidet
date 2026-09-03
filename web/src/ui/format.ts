/** Plain-language time. Intervals here run from minutes to years. */
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < HOUR) return `${Math.max(1, Math.round(abs / MIN))} min`
  if (abs < DAY) return `${Math.round(abs / HOUR)} h`
  const days = Math.round(abs / DAY)
  if (days < 31) return `${days} d`
  if (days < 365) return `${Math.round(days / 30.44)} mo`
  const years = days / 365.25
  return `${years < 10 ? years.toFixed(1) : Math.round(years)} y`
}

/** "in 4 h", "3 d ago", "now". */
export function formatWhen(at: number, now: number): string {
  const delta = at - now
  if (Math.abs(delta) < MIN) return 'now'
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`
}
