/**
 * The guarantees from DESIGN.md §6: review with no network, and a reload that
 * lands exactly where it left off.
 *
 * Everything is driven through the real interface — no test-only hooks in the
 * shipped bundle — so these also cover deck creation, card editing and the
 * grade fan-out on the way past.
 */
import { expect, test, type Page } from '@playwright/test'
import { goOffline, goOnline, waitForPrecache } from './helpers.ts'

async function createDeck(page: Page, name: string, fields: string[]) {
  await page.goto('/')
  await page.getByRole('button', { name: /Add deck/ }).click()
  await page.getByLabel('Deck name').fill(name)
  for (let i = 2; i < fields.length; i++) {
    await page.getByRole('button', { name: 'Add field' }).click()
  }
  for (const [i, field] of fields.entries()) {
    await page.getByLabel(`Field ${i + 1} name`).fill(field)
  }
  await page.getByRole('button', { name: 'Create deck' }).click()
  await expect(page.getByRole('button', { name: 'Add card' })).toBeVisible()
}

async function addCard(page: Page, values: string[]) {
  await page.getByRole('button', { name: 'Add card' }).click()
  const boxes = page.locator('textarea.field__input')
  for (const [i, value] of values.entries()) await boxes.nth(i).fill(value)
  await page.getByRole('button', { name: 'Save card' }).click()
  await expect(page.getByRole('button', { name: 'Add card' })).toBeVisible()
}

async function reviewCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const res = await fetch('/api/changes?since=0')
    return ((await res.json()) as { reviews: unknown[] }).reviews.length
  })
}

test.describe('offline review', () => {
  test('creates a collection, reviews it with no network, and syncs afterwards', async ({
    page,
  }) => {
    await page.goto('/')
    await waitForPrecache(page)

    await createDeck(page, 'Kanji', ['glyph', 'reading', 'meaning'])
    await addCard(page, ['憂', 'ユウ', 'grief'])
    await addCard(page, ['慮', 'リョ', 'consider'])

    // The content reaches the server while it is reachable.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const res = await fetch('/api/changes?since=0')
          return ((await res.json()) as { cards: unknown[] }).cards.length
        }),
      )
      .toBe(2)

    const before = await reviewCount(page)

    // Cut the network. Everything from here is local-only.
    await goOffline(page)

    await page.goto('/')
    await expect(page.locator('.wordmark')).toHaveText('eidet')

    await page.getByRole('button', { name: /^Review \d+ sides?$/ }).click()
    await expect(page).toHaveURL(/\/review\//)

    // Grade two cards with no server in reach.
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Reveal' }).click()
      await expect(page.locator('.row').first()).toBeVisible()
      await page.getByRole('button', { name: 'Good', exact: true }).click()
    }

    // Reviews are in IndexedDB and queued, with nothing lost to the dead network.
    const queued = await page.evaluate(async () => {
      const open = indexedDB.open('eidet')
      const db = await new Promise<IDBDatabase>((res) => {
        open.onsuccess = () => res(open.result)
      })
      const all = (store: string) =>
        new Promise<unknown[]>((res) => {
          const req = db.transaction(store).objectStore(store).getAll()
          req.onsuccess = () => res(req.result)
        })
      return { reviews: (await all('reviews')).length, outbox: (await all('outbox')).length }
    })
    expect(queued.reviews).toBeGreaterThan(0)
    expect(queued.outbox).toBeGreaterThan(0)

    // Nothing reached the server while it was unreachable.
    await goOnline(page)
    await expect.poll(() => reviewCount(page), { timeout: 30_000 }).toBeGreaterThan(before)
  })

  test('a reload mid-reveal returns to the identical screen', async ({ page }) => {
    await page.goto('/')
    await waitForPrecache(page)
    await createDeck(page, 'Birds', ['species', 'song'])
    await addCard(page, ['Winter wren', 'A long tumbling cascade'])
    await addCard(page, ['Chiffchaff', 'Its own name, over and over'])

    await page.getByRole('button', { name: /^Review \d+ sides?$/ }).click()
    await page.getByRole('button', { name: 'Reveal' }).click()

    // Mark a side missed, then reload.
    const row = page.locator('.row').first()
    await row.click()
    await expect(row).toHaveAttribute('aria-pressed', 'true')

    const before = {
      url: page.url(),
      cue: await page.locator('.docked__cue').textContent(),
      left: await page.locator('.strip__count').textContent(),
      rows: await page.locator('.row__value').allTextContents(),
    }

    await page.reload()

    // Same session, same position, same phase, same toggle — nothing re-asked.
    expect(page.url()).toBe(before.url)
    await expect(page.locator('.docked__cue')).toHaveText(before.cue!)
    await expect(page.locator('.strip__count')).toHaveText(before.left!)
    await expect(page.locator('.row__value')).toHaveText(before.rows)
    await expect(page.locator('.row').first()).toHaveAttribute('aria-pressed', 'true')
  })

  test('a reload mid-edit keeps the unsaved draft', async ({ page }) => {
    await page.goto('/')
    await waitForPrecache(page)
    await createDeck(page, 'Drafts', ['front', 'back'])

    await page.getByRole('button', { name: 'Add card' }).click()
    await page.locator('textarea.field__input').first().fill('half typed')
    await page.waitForTimeout(300)
    await page.reload()

    await expect(page.locator('textarea.field__input').first()).toHaveValue('half typed')
  })

  test('cold start works from precache with the network already down', async ({ page }) => {
    await page.goto('/')
    await waitForPrecache(page)
    await goOffline(page)
    await page.goto('/')
    await expect(page.locator('.wordmark')).toHaveText('eidet')
    await goOnline(page)
  })
})
