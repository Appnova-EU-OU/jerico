/**
 * Every channel main sends must have a preload listener, and vice versa.
 *
 * This is the one part of the main↔renderer contract that no typechecker can see:
 * the channel name is a string literal repeated in two files that never import each
 * other. `svelte-check` (added alongside this file) proves that the object exposed
 * through contextBridge satisfies `BridgeAPI` — that is a type relation and it is
 * checked properly. A channel name is not.
 *
 * 0.25.0 is the reason this exists. `popover.ts` sent `popover:hidden` and the
 * preload had no listener for it, so `window.bridge.onPopoverHidden` was undefined,
 * the renderer's call threw inside `onMount`, and the throw unwound the rest of that
 * function — killing the NEXT registration, `onPopoverOpened`, and with it
 * refresh-on-open, folding back to the main view, the activity fold, the
 * announcement, focusing the primary control, and `popoverRequestState()`, which is
 * what drives the first-open state replay. Nothing on screen looked wrong, because
 * the state listener registers before the throw and the card paints from it.
 *
 * An earlier version of this file tried to check member completeness by scanning
 * `BridgeAPI` and the preload object as text. Four independent reviewers broke it in
 * both directions: it invented members that do not exist (a wrapped signature with
 * two callback parameters is enough) and it reported a missing member as present
 * (any line-initial `name:` anywhere in the file satisfied it, including inside an
 * unrelated map). svelte-check gets both cases right and reports
 * `Property 'onPopoverHidden' is missing in type … but required in type 'BridgeAPI'`
 * with exit 1. So member completeness is deliberately NOT retested here; a second,
 * weaker gate over the same property earns nothing and its phantom failures are how
 * a gate gets deleted by the next person.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Comments are not code: a commented-out send must not count as a send. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readTree(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) readTree(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

function sourcesOf(rel: string): { file: string; text: string }[] {
  return readTree(join(here, '..', rel)).map((file) => ({ file, text: stripComments(readFileSync(file, 'utf8')) }))
}

const mainSources = sourcesOf('src/main')
const preloadSources = sourcesOf('src/preload')

function literals(sources: { text: string }[], pattern: RegExp): Set<string> {
  const found = new Set<string>()
  for (const { text } of sources) {
    for (const m of text.matchAll(pattern)) if (m[1]) found.add(m[1])
  }
  return found
}

/**
 * `webContents.send('x')` — main → renderer. Anchored on `webContents` on purpose:
 * a bare `.send(` also matches `updateWindow.send({ type: … })`, a wrapper whose
 * first argument is a payload and not a channel at all.
 */
const sent = literals(mainSources, /webContents\.send\(\s*'([^']+)'/g)
/** `ipcRenderer.on('x', …)` — the only way a renderer can hear one. */
const heard = literals(preloadSources, /ipcRenderer\.on\(\s*'([^']+)'/g)

test('the scan found something, so a broken regex cannot pass as a pass', () => {
  assert.ok(sent.size >= 5, `found only ${String(sent.size)} sent channels; the scanner is wrong, not the code`)
  assert.ok(heard.size >= 5, `found only ${String(heard.size)} preload listeners`)
})

test('no channel name is computed, because this gate can only read literals', () => {
  // A `send(CHANNEL)` would be invisible here and the gate would quietly cover
  // less than it claims. Better to fail and be told to keep channels literal.
  const computed: string[] = []
  for (const { file, text } of [...mainSources, ...preloadSources]) {
    for (const m of text.matchAll(/(?:webContents\.send|ipcRenderer\.on)\(\s*([^'\s)])/g)) {
      computed.push(`${file.slice(file.indexOf('src/'))}: …(${String(m[1])}…`)
    }
  }
  assert.deepEqual(computed, [], 'channel names must be inline string literals for this gate to see them')
})

test('every channel main sends has a preload listener', () => {
  const orphanSends = [...sent].filter((c) => !heard.has(c)).sort()
  assert.deepEqual(
    orphanSends,
    [],
    `main sends these and no preload listener exists, so the renderer can never observe them: ${orphanSends.join(', ')}`,
  )
})

test('every preload listener has a sender in main', () => {
  // The mirror direction. Not merely tidiness: it catches a rename that moved the
  // send and left the listener behind, which presents as a callback that simply
  // never fires — the hardest kind of nothing to notice.
  const orphanListeners = [...heard].filter((c) => !sent.has(c)).sort()
  assert.deepEqual(
    orphanListeners,
    [],
    `the preload listens for these and nothing in main sends them: ${orphanListeners.join(', ')}`,
  )
})

test('the 0.25.0 channel specifically is wired on all three sides', () => {
  // Named explicitly so the regression that motivated the file cannot come back by
  // a route the set comparison above happens not to model.
  assert.ok(sent.has('popover:hidden'), 'main no longer sends popover:hidden')
  assert.ok(heard.has('popover:hidden'), 'the preload no longer listens for popover:hidden')
  const popover = readFileSync(join(here, '../src/renderer/src/routes/Popover.svelte'), 'utf8')
  assert.match(popover, /onPopoverHidden\(/, 'the renderer no longer consumes it')
})
