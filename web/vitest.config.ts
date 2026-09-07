import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// `e2e/` belongs to Playwright (`make e2e`); vitest owns the unit tests only.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    // Component tests need a DOM; the pure ones don't care either way.
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
