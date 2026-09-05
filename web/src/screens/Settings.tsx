/**
 * Settings. See DESIGN.md §4.
 *
 * Four things: whether the server has this device's work, the two FSRS
 * parameters worth touching, how much room the collection takes, and a way to
 * get everything out. No preferences for their own sake.
 *
 * Changing a parameter writes a new `ParamSet` — they are immutable and keyed
 * by content hash — and replays every side's log under it (§2). That is slow
 * and deliberate, which is why it is a button and not a live slider.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import { DEFAULT_PARAMS, paramSet } from '@eidet/shared'
import { db } from '../db/db.ts'
import { replayAll, setParams } from '../db/mutations.ts'
import { useCurrentParams } from '../db/useParams.ts'
import { formatWhen } from '../ui/format.ts'
import { useSyncStatus } from '../sync/SyncContext.tsx'

/** Retention targets worth offering. Below .8 you forget; above .95 you grind. */
const RETENTIONS = [0.8, 0.85, 0.9, 0.95]
const STEP_CHOICES: { steps: string[]; label: string }[] = [
  { steps: ['1m', '10m'], label: 'A minute, then ten' },
  { steps: ['10m'], label: 'Ten minutes, once' },
  { steps: ['1m', '5m', '20m'], label: 'A minute, five, then twenty' },
]

export function Settings() {
  const navigate = useNavigate()
  const now = Date.now()
  const { status, lastSyncedAt, syncNow } = useSyncStatus()
  const params = useCurrentParams()
  const counts = useLiveQuery(async () => ({
    decks: await db.decks.filter((d) => d.deletedAt === null).count(),
    cards: await db.cards.filter((c) => c.deletedAt === null).count(),
    sides: await db.memories.count(),
    reviews: await db.reviews.count(),
    unsent: await db.outbox.count(),
  }))
  const [usage, setUsage] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setUsage(e.usage ?? null))
  }, [])

  if (!params || !counts) return <div className="app" />

  const apply = async (retention: number, steps: string[]) => {
    setBusy(true)
    const next = paramSet([...params.w], retention, steps, Date.now())
    await setParams(next)
    await replayAll(next)
    setBusy(false)
  }

  return (
    <div className="app">
      <div className="strip">
        <button className="strip__back" onClick={() => navigate('/')} aria-label="Back to decks">
          ‹
        </button>
        <span>Settings</span>
      </div>

      <div className="editor">
        <section>
          <h2 className="settings__head">Server</h2>
          <p className="rest rest--tight">
            {status === 'offline'
              ? 'Out of reach. Everything is saved on this phone and goes up when the server answers.'
              : lastSyncedAt
                ? `Last synced ${formatWhen(lastSyncedAt, now)}.`
                : 'Syncing.'}
            {counts.unsent > 0
              ? ` ${counts.unsent} ${counts.unsent === 1 ? 'change' : 'changes'} still to send.`
              : ''}
          </p>
          <button className="action action--quiet" onClick={syncNow} disabled={status === 'syncing'}>
            {status === 'syncing' ? 'Syncing' : 'Sync now'}
          </button>
        </section>

        <section>
          <h2 className="settings__head">Target recall</h2>
          <p className="rest rest--tight">
            How well you want to remember a side when it comes back up. Aiming higher means
            seeing everything more often.
          </p>
          <div className="choices choices--row">
            {RETENTIONS.map((r) => (
              <button
                key={r}
                className={`choice choice--slim${r === params.requestRetention ? ' choice--on' : ''}`}
                aria-pressed={r === params.requestRetention}
                disabled={busy}
                onClick={() => apply(r, params.learningSteps)}
              >
                <span className="num">{Math.round(r * 100)}%</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="settings__head">First encounter</h2>
          <p className="rest rest--tight">
            How soon a brand-new side comes back within the same sitting.
          </p>
          <div className="choices">
            {STEP_CHOICES.map((choice) => {
              const on = choice.steps.join() === params.learningSteps.join()
              return (
                <button
                  key={choice.label}
                  className={`choice${on ? ' choice--on' : ''}`}
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => apply(params.requestRetention, choice.steps)}
                >
                  <span className="choice__title">{choice.label}</span>
                </button>
              )
            })}
          </div>
          {busy ? <p className="rest">Replaying every review under the new settings.</p> : null}
          {params.requestRetention !== DEFAULT_PARAMS.request_retention ||
          params.learningSteps.join() !== DEFAULT_PARAMS.learning_steps.join() ? (
            <button
              className="link settings__reset"
              disabled={busy}
              onClick={() =>
                apply(DEFAULT_PARAMS.request_retention, [...DEFAULT_PARAMS.learning_steps])
              }
            >
              Back to the defaults
            </button>
          ) : null}
        </section>

        <section>
          <h2 className="settings__head">Storage</h2>
          <p className="rest rest--tight">
            {counts.decks} {counts.decks === 1 ? 'deck' : 'decks'}, {counts.cards}{' '}
            {counts.cards === 1 ? 'card' : 'cards'}, {counts.sides} scheduled{' '}
            {counts.sides === 1 ? 'side' : 'sides'}, {counts.reviews}{' '}
            {counts.reviews === 1 ? 'review' : 'reviews'}.
          </p>
          <p className="rest rest--tight">
            {usage === null ? 'Measuring what it takes up.' : `Using ${formatBytes(usage)}.`}
          </p>
          <ExportButton />
        </section>
      </div>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  const mb = bytes / 1024 / 1024
  return mb < 1 ? `${Math.round(bytes / 1024)} kB` : `${mb.toFixed(1)} MB`
}

/**
 * Everything, as one JSON file. Blobs are left out on purpose — they are large
 * and already content-addressed on the server; this is the record that cannot
 * be reconstructed.
 */
function ExportButton() {
  const [done, setDone] = useState(false)

  const save = async () => {
    const [decks, cards, reviews, paramSets] = await Promise.all([
      db.decks.toArray(),
      db.cards.toArray(),
      db.reviews.toArray(),
      db.paramSets.toArray(),
    ])
    const blob = new Blob([JSON.stringify({ decks, cards, reviews, paramSets }, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `eidet-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setDone(true)
  }

  return (
    <>
      <button className="action action--quiet" onClick={save}>
        Export everything
      </button>
      {done ? <p className="rest">Saved as a JSON file.</p> : null}
    </>
  )
}
