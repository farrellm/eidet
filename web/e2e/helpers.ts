import type { Page } from '@playwright/test'

/**
 * Playwright's `setOffline` does not set `navigator.onLine` on documents loaded
 * afterwards, so a reload-while-offline test would silently take the online
 * path. This init script is what keeps that test honest.
 */
export async function goOffline(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true })
  })
  await page.context().setOffline(true)
}

export async function goOnline(page: Page) {
  await page.context().setOffline(false)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true })
  })
}

/** Wait for the service worker to finish precaching before cutting the network. */
export async function waitForPrecache(page: Page) {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration()
    return !!reg?.active
  }, null, { timeout: 20_000 })
  // Give Workbox a moment to finish writing the precache.
  await page.waitForTimeout(1500)
}
