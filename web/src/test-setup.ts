/**
 * Test environment. See DESIGN.md §10.
 *
 * jsdom has no IndexedDB and no `matchMedia`, and the components under test
 * reach for both — Dexie for a side's memory, `CueCard` to decide whether to
 * play the dock. Both are supplied here rather than mocked per test, so the
 * components run the same code path they run in the browser.
 */
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

// jsdom implements neither, and the FLIP in CueCard calls both.
if (!Element.prototype.animate) {
  Element.prototype.animate = (() => ({
    finished: Promise.resolve(),
    cancel: () => {},
  })) as unknown as typeof Element.prototype.animate
}

afterEach(cleanup)
