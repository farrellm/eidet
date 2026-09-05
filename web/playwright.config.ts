import { defineConfig } from '@playwright/test'

/**
 * The offline/PWA suite runs against a *production* build served by the real
 * server: the service worker is disabled in dev, so the Vite dev server cannot
 * exercise any of this.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: 'http://127.0.0.1:8087',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'node --experimental-strip-types ../server/src/index.ts',
    url: 'http://127.0.0.1:8087/api/healthz',
    reuseExistingServer: false,
    env: {
      EIDET_PORT: '8087',
      EIDET_DATA: './.e2e-data',
      EIDET_WEB: './dist',
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
