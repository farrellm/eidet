import { rmSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

/*
 * A run starts from an empty server. The suite asserts exact row counts, so a
 * database left behind by the previous run makes every one of them wrong — and
 * the failure looks like a sync bug rather than a dirty fixture.
 *
 * Guarded, because this file is not loaded once. Playwright re-imports the
 * config in its loader and in every worker process, and those loads happen
 * *after* `webServer` has started — an unguarded wipe would delete the database
 * out from under the running server mid-run. The flag rides along in the
 * environment the children inherit, so only the runner that set it wipes.
 */
if (!process.env.EIDET_E2E_WIPED) {
  process.env.EIDET_E2E_WIPED = '1'
  rmSync(new URL('./.e2e-data', import.meta.url), { recursive: true, force: true })
}

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
