/**
 * Plain-language time. Intervals here run from minutes to years.
 *
 * Written out in full rather than abbreviated: §8 asks for plain words, and
 * "Next batch in 4 hours" is the copy §4 specifies. Abbreviation would save a
 * few characters in a layout that has the room for them.
 */
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < HOUR) return plural(Math.max(1, Math.round(abs / MIN)), 'minute')
  if (abs < DAY) return plural(Math.round(abs / HOUR), 'hour')
  const days = Math.round(abs / DAY)
  if (days < 31) return plural(days, 'day')
  if (days < 365) return plural(Math.round(days / 30.44), 'month')
  const years = days / 365.25
  return years < 10 ? `${years.toFixed(1)} years` : plural(Math.round(years), 'year')
}

/** "in 4 hours", "3 days ago", "now". */
export function formatWhen(at: number, now: number): string {
  const delta = at - now
  if (Math.abs(delta) < MIN) return 'now'
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`
}
