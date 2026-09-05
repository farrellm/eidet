/**
 * One press covers every row that was not marked missed. See DESIGN.md §1.
 *
 * The four grades are peers — none of them is the action of the moment, so none
 * of them wears brass (§3 principle 3).
 */
import type { Grade } from '@eidet/shared'

const GRADES: { rating: Grade; label: string }[] = [
  { rating: 1, label: 'Again' },
  { rating: 2, label: 'Hard' },
  { rating: 3, label: 'Good' },
  { rating: 4, label: 'Easy' },
]

export function GradeBar({ onGrade }: { onGrade: (rating: Grade) => void }) {
  return (
    <div className="dock grades">
      {GRADES.map((g) => (
        <button key={g.rating} className="grade" onClick={() => onGrade(g.rating)}>
          {g.label}
        </button>
      ))}
    </div>
  )
}
