import { defineConfig } from 'vitest/config'

// `e2e/` belongs to Playwright (`make e2e`); vitest owns the unit tests only.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
