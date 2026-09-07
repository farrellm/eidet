import { Route, Routes } from 'react-router'
import { SyncProvider } from './sync/SyncContext.tsx'
import { Today } from './screens/Today.tsx'
import { DeckScreen } from './screens/DeckScreen.tsx'
import { DeckSettings } from './screens/DeckSettings.tsx'
import { CardEditor } from './screens/CardEditor.tsx'
import { Review } from './screens/Review.tsx'
import { Settings } from './screens/Settings.tsx'
import { UpdatePrompt } from './ui/UpdatePrompt.tsx'

export function App() {
  return (
    <SyncProvider>
      <UpdatePrompt />
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/deck/new" element={<DeckSettings />} />
        <Route path="/deck/:deckId" element={<DeckScreen />} />
        <Route path="/deck/:deckId/settings" element={<DeckSettings />} />
        <Route path="/deck/:deckId/card/:cardId" element={<CardEditor />} />
        {/* The session id lives in the URL so a reload restores the exact position. */}
        <Route path="/review/:sessionId" element={<Review />} />
      </Routes>
    </SyncProvider>
  )
}
