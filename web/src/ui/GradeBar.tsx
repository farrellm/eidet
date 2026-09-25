/**
 * One press covers every row that was not marked missed. See DESIGN.md §1.
 *
 * The four grades are peers — none of them is the action of the moment, so none
 * of them wears brass (§3 principle 3).
 */
import { Grade } from '@eidet/shared'

/** In the order the bar shows them; the label is the key's own name. */
const GRADES = Object.entries(Grade).map(([label, rating]) => ({ label, rating }))

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
