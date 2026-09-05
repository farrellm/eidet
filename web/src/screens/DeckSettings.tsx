/**
 * Creating and configuring a deck. See DESIGN.md §1 (deck field model).
 *
 * A schema deck declares its fields once and every card gets one slot per
 * field; a freeform deck lets each card carry its own. The mode is picked here,
 * at creation, because it decides the shape of every editor afterwards.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useLiveQuery } from 'dexie-react-hooks'
import type { Deck, DeckField, DeckMode } from '@eidet/shared'
import { db } from '../db/db.ts'
import { createDeck, deleteDeck, moveDeck, newId, updateDeck } from '../db/mutations.ts'

const STARTER: DeckField[] = [
  { id: 'f1', name: 'front', kind: 'text', tested: true },
  { id: 'f2', name: 'back', kind: 'text', tested: true },
]

export function DeckSettings() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const isNew = deckId === undefined
  const existing = useLiveQuery(() => (deckId ? db.decks.get(deckId) : undefined), [deckId])

  const [name, setName] = useState('')
  const [mode, setMode] = useState<DeckMode>('schema')
  const [fields, setFields] = useState<DeckField[]>(STARTER)
  const [cuePreference, setCuePreference] = useState<Deck['cuePreference']>('auto')
  const [seeded, setSeeded] = useState(false)
  const siblings = useLiveQuery(
    () => db.decks.filter((d) => d.deletedAt === null).sortBy('order'),
    [],
  )

  if (!isNew && existing && !seeded) {
    setSeeded(true)
    setName(existing.name)
    setMode(existing.mode)
    setFields(existing.fields.length > 0 ? existing.fields : STARTER)
    setCuePreference(existing.cuePreference)
  }

  const save = async () => {
    const trimmed = fields
      .map((f) => ({ ...f, name: f.name.trim() }))
      .filter((f) => f.name.length > 0)
    // A pinned cue only means something for a schema deck, and only while the
    // field it names still exists.
    const pinned =
      mode === 'schema' && trimmed.some((f) => f.id === cuePreference && f.tested)
        ? cuePreference
        : 'auto'
    const payload = {
      name: name.trim() || 'Untitled deck',
      mode,
      fields: mode === 'schema' ? trimmed : [],
      cuePreference: pinned as Deck['cuePreference'],
    }
    if (isNew) {
      const id = await createDeck(payload)
      navigate(`/deck/${id}`)
    } else {
      await updateDeck(deckId!, payload)
      navigate(`/deck/${deckId}`)
    }
  }

  const canSave = mode === 'freeform' || fields.filter((f) => f.name.trim()).length >= 2

  return (
    <div className="app">
      <div className="strip">
        <button className="strip__back" onClick={() => navigate(-1)} aria-label="Go back">
          ‹
        </button>
        <span>{isNew ? 'New deck' : 'Deck settings'}</span>
        <span className="strip__spacer" />
      </div>

      <div className="editor">
        <section className="field">
          <label className="label" htmlFor="deck-name">
            Deck name
          </label>
          <input
            id="deck-name"
            className="field__input"
            value={name}
            placeholder="Kanji"
            onChange={(e) => setName(e.target.value)}
          />
        </section>

        <section className="field">
          <span className="label">Card shape</span>
          <div className="choices">
            <Choice
              checked={mode === 'schema'}
              onSelect={() => setMode('schema')}
              title="Same fields on every card"
              detail="Name the fields once. Every card gets a slot for each, and blank slots are skipped."
            />
            <Choice
              checked={mode === 'freeform'}
              onSelect={() => setMode('freeform')}
              title="Different sides per card"
              detail="Each card carries its own labelled sides. Nothing lines up, but anything goes."
            />
          </div>
        </section>

        {mode === 'schema' ? (
          <section className="field">
            <span className="label">Fields</span>
            <p className="rest rest--tight">
              Tested fields get their own schedule. Untested ones are shown when a card is revealed
              but never asked.
            </p>
            {fields.map((f, i) => (
              <div key={f.id} className="field__row">
                <input
                  className="field__input"
                  value={f.name}
                  placeholder={`Field ${i + 1}`}
                  aria-label={`Field ${i + 1} name`}
                  onChange={(e) =>
                    setFields(fields.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)))
                  }
                />
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={f.tested}
                    onChange={(e) =>
                      setFields(
                        fields.map((x) => (x.id === f.id ? { ...x, tested: e.target.checked } : x)),
                      )
                    }
                  />
                  <span className="label">Test</span>
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={f.kind === 'image'}
                    onChange={(e) =>
                      setFields(
                        fields.map((x) =>
                          x.id === f.id ? { ...x, kind: e.target.checked ? 'image' : 'text' } : x,
                        ),
                      )
                    }
                  />
                  <span className="label">Image</span>
                </label>
                {fields.length > 2 ? (
                  <button
                    className="link"
                    onClick={() => setFields(fields.filter((x) => x.id !== f.id))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            <button
              className="action action--quiet"
              onClick={() =>
                setFields([...fields, { id: newId(), name: '', kind: 'text', tested: true }])
              }
            >
              Add field
            </button>
          </section>
        ) : null}

        {mode === 'schema' ? (
          <section className="field">
            <span className="label">Which side prompts you</span>
            <p className="rest rest--tight">
              Pin a field if this deck has an obvious direction. Otherwise the best-known side of
              each card is used, which keeps the prompt one you actually recognise.
            </p>
            <div className="choices">
              <Choice
                checked={cuePreference === 'auto'}
                onSelect={() => setCuePreference('auto')}
                title="Whichever side you know best"
              />
              {/* Tested fields only. Pinning an untested one is the exact
                  mistake §11 records: a card whose source note is a side
                  should not be prompted by the note. */}
              {fields
                .filter((f) => f.name.trim() && f.tested)
                .map((f) => (
                  <Choice
                    key={f.id}
                    checked={cuePreference === f.id}
                    onSelect={() => setCuePreference(f.id)}
                    title={f.name.trim()}
                  />
                ))}
            </div>
          </section>
        ) : null}

        {!isNew && siblings && siblings.length > 1 ? (
          <DeckOrder deckId={deckId!} decks={siblings} />
        ) : null}
      </div>

      <div className="dock">
        <button className="action" onClick={save} disabled={!canSave}>
          {isNew ? 'Create deck' : 'Save deck'}
        </button>
        {!canSave ? <p className="rest">A deck needs at least two named fields.</p> : null}
        {!isNew ? (
          <button
            className="action action--quiet add-deck"
            onClick={async () => {
              await deleteDeck(deckId!)
              navigate('/')
            }}
          >
            Delete deck
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Choice({
  checked,
  onSelect,
  title,
  detail,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  detail?: string
}) {
  return (
    <button
      className={`choice${checked ? ' choice--on' : ''}`}
      onClick={onSelect}
      aria-pressed={checked}
    >
      <span className="choice__title">{title}</span>
      {detail ? <span className="choice__detail">{detail}</span> : null}
    </button>
  )
}

/**
 * Where this deck sits on the home screen. Two buttons rather than a drag: a
 * handful of decks reorder fine by nudging, and a drag target is the fiddliest
 * thing you can ask of a thumb.
 */
function DeckOrder({ deckId, decks }: { deckId: string; decks: Deck[] }) {
  const at = decks.findIndex((d) => d.id === deckId)
  if (at === -1) return null

  return (
    <section className="field">
      <span className="label">Position</span>
      <p className="rest rest--tight">
        Number {at + 1} of {decks.length} on the home screen.
      </p>
      <div className="field__row">
        <button
          className="action action--quiet field__pick"
          disabled={at === 0}
          onClick={() => moveDeck(deckId, -1)}
        >
          Move up
        </button>
        <button
          className="action action--quiet field__pick"
          disabled={at === decks.length - 1}
          onClick={() => moveDeck(deckId, 1)}
        >
          Move down
        </button>
      </div>
    </section>
  )
}
