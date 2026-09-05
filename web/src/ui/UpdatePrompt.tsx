/**
 * Service-worker registration and the update prompt.
 *
 * Registration lives here rather than in `main.tsx` so the prompt and the
 * registration cannot drift apart. The update is never applied automatically:
 * reloading mid-reveal would throw away an ungraded card.
 */
import { useRegisterSW } from 'virtual:pwa-register/react'

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()

  if (!needRefresh) return null

  return (
    <div className="update" role="status">
      <span>A new version is ready.</span>
      <span className="update__actions">
        <button className="link" onClick={() => setNeedRefresh(false)}>
          Later
        </button>
        <button className="link" onClick={() => void updateServiceWorker(true)}>
          Reload now
        </button>
      </span>
    </div>
  )
}
