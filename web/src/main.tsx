import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/literata'
import './ui/tokens.css'
import { App } from './App.tsx'

if (import.meta.env.DEV) {
  void import('./db/seed.ts').then((m) => {
    ;(window as unknown as { __seed: () => Promise<void> }).__seed = m.seed
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
