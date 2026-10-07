/**
 * A static guard on the two lines that decide whether the tray icon works.
 *
 * `PopoverWindow` needs Electron, so its behaviour cannot be exercised here. What
 * CAN be guarded is the ordering that made it fail, and it is worth guarding
 * because the failure is invisible in review and total for the user:
 *
 *   open the card → Cmd+W (`role: 'close'` in app-menu.ts) → the window is
 *   destroyed without going through hide() → `visible` stays true → isOpen()
 *   answers true forever → every tray click takes the hide branch → the menu-bar
 *   icon is dead for the rest of the session, and recovery is relaunching the app.
 *
 * That is strictly worse than the "needs several clicks" bug the flag was added to
 * fix, and it survived a four-reviewer pass: it was raised, dismissed by the
 * author on a diff-scoped search of popover.ts, and only found when a reviewer
 * looked OUTSIDE the diff at who else can close a window.
 *
 * These are source-text assertions in the same spirit as scripts/assert-test-integrity.mjs
 * and scripts/check-test-db-url.mjs — cheap, and they fail the moment someone
 * reorders the lines back.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

const raw = readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'main', 'popover.ts'),
  'utf-8',
)

/**
 * Comments stripped before anything is searched.
 *
 * Not paranoia — the first version of this file failed on correct code because
 * popover.ts's own comment EXPLAINS the ordering bug, so the string `win.show()`
 * appears in prose above the call it warns about. A guard that reads comments is
 * measuring the documentation.
 */
const source = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** The body of `hide()`, up to the next method. */
function hideBody(): string {
  const start = source.indexOf('hide(): void {')
  assert.notStrictEqual(start, -1, 'hide() not found — this guard needs updating')
  const rest = source.slice(start)
  // The next top-level member starts at a line with exactly two spaces of indent
  // that is not part of this body.
  const end = rest.search(/\n  (?:\/\*\*|[a-zA-Z]+\([^)]*\)\s*:|private |public )/g)
  return end === -1 ? rest : rest.slice(0, end)
}

test('hide() clears `visible` BEFORE any early return', () => {
  const body = hideBody()
  const clear = body.indexOf('this.visible = false')
  const guard = body.indexOf('isDestroyed()')
  assert.notStrictEqual(clear, -1, 'hide() must clear this.visible')
  assert.notStrictEqual(guard, -1, 'hide() is expected to guard on isDestroyed()')
  assert.ok(
    clear < guard,
    'hide() must set this.visible = false BEFORE the isDestroyed() early return.\n' +
      'With the guard first, a window closed by Cmd+W leaves the flag set and the\n' +
      'tray icon never opens again for the rest of the session.',
  )
})

test("the window's `closed` handler clears `visible`", () => {
  const start = source.indexOf("win.on('closed'")
  assert.notStrictEqual(start, -1, "no closed handler found — this guard needs updating")
  // The handler body: to the closing `})` of this listener.
  const body = source.slice(start, source.indexOf('})', start) + 2)
  assert.ok(
    body.includes('this.visible = false'),
    'the closed handler must clear this.visible.\n' +
      'Cmd+W destroys the window without calling hide(), so this is the only place\n' +
      'that observes it. `win.on("hide")` is NOT a substitute — a destroyed window\n' +
      'does not emit hide.',
  )
  assert.ok(
    body.includes('this.nested = false'),
    'the closed handler must also clear nested, or the next open swallows its first Escape',
  )
})

test('show() activates the app before showing the window', () => {
  // The other half of the same defect: `win.show()` on a hidden app draws nothing
  // while still reporting the window visible. hide() hides the whole app, so this
  // ordering is what makes the first click after a dismissal work.
  const start = source.indexOf('show(tray: Tray): void {')
  assert.notStrictEqual(start, -1, 'show() not found — this guard needs updating')
  const body = source.slice(start, start + 1400)
  const focus = body.indexOf('app.focus({ steal: true })')
  const show = body.indexOf('win.show()')
  assert.notStrictEqual(focus, -1, 'show() must activate the app')
  assert.notStrictEqual(show, -1, 'show() must show the window')
  assert.ok(focus < show, 'app.focus({steal:true}) must come BEFORE win.show()')
})

test('isOpen() reads the flag, not the window', () => {
  const start = source.indexOf('isOpen(): boolean {')
  assert.notStrictEqual(start, -1, 'isOpen() not found — this guard needs updating')
  const body = source.slice(start, source.indexOf('}', start) + 1)
  assert.ok(body.includes('this.visible'), 'isOpen() must read the flag')
  assert.ok(
    !body.includes('isVisible()'),
    'isOpen() must NOT ask the window: a window inside a hidden app reports itself\n' +
      'visible, which is the reading that made the second tray click hide an\n' +
      'invisible card.',
  )
})
