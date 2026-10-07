import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { classifyHealth } from '../src/main/utils/health-classify.ts'
import { projectFromCwd } from '../src/main/utils/popover-model.ts'

/** Copied from a live /health response served by feat/daemon-popover-readings,
 *  not from a shape imagined on this side. */
const LIVE = {
  connected: true,
  activePanels: 2,
  agentIds: ['a-1', 'a-2'],
  pongRttHistory: [37, 3, 5, 0],
  panels: [
    { agentId: 'a-1', agentKey: 'sh', cwd: '/Users/me/Development/jerico' },
    { agentId: 'a-2', agentKey: 'claude', cwd: '/Users/me/Development/orca', usagePct: 15,
      hook: { configState: 'present_ok', hookInstallRefused: { status: 'refused-conflict', at: 1234 } } },
  ],
}

test("the daemon's own field names are the ones read", () => {
  const r = classifyHealth(LIVE, null, 200)
  assert.equal(r.panels.length, 2)
  assert.deepEqual(r.panels[0], {
    agentId: 'a-1', agentKey: 'sh', cwd: '/Users/me/Development/jerico', usagePct: null, hook: null, startupGate: null,
    // This fixture's daemon does not send the field, and 'unknown' is the only
    // honest reading of that — see the id-only case below.
    startupGateSupport: 'unknown',
  })
  assert.deepEqual(r.panels[1], {
    agentId: 'a-2', agentKey: 'claude', cwd: '/Users/me/Development/orca', usagePct: 15,
    hook: { configState: 'present_ok', hookInstallRefused: { status: 'refused-conflict', at: 1234 } }, startupGate: null,
    startupGateSupport: 'unknown',
  })
  assert.deepEqual(r.rttHistory, [37, 3, 5, 0])
})

// The regression this file exists for. The first version of the reader keyed on
// `id`/`agent`/`project`/`contextPct` — names guessed before the daemon side
// existed. Because `Array.isArray(panels)` was true it returned [] and never
// reached the agentIds fallback, so a machine with two panels running rendered
// "no panels open". A confident lie, from a reader that was merely wrong.
test('an unparseable panels array falls back to agentIds, never to empty', () => {
  const r = classifyHealth(
    { ...LIVE, panels: [{ id: 'x', agent: 'claude' }, { id: 'y' }] },
    null,
    200,
  )
  assert.equal(r.panels.length, 2, 'must not report zero panels while two are live')
  assert.deepEqual(r.panels.map((p) => p.agentId), ['a-1', 'a-2'])
  assert.equal(r.panels[0]?.cwd, null, 'and must not invent detail it does not have')
})

test('an empty panels array from a daemon that has the field is a real zero', () => {
  const r = classifyHealth({ connected: true, activePanels: 0, agentIds: [], panels: [] }, null, 200)
  assert.deepEqual(r.panels, [])
})

test('a daemon too old to send panels still lists what it does send', () => {
  const r = classifyHealth({ connected: true, activePanels: 1, agentIds: ['old-1'] }, null, 200)
  assert.deepEqual(r.panels, [{
    agentId: 'old-1', agentKey: null, cwd: null, usagePct: null, hook: null, startupGate: null,
    // A daemon this old says nothing about gate monitoring. Reading that as
    // 'not_applicable' would silence a real blocked gate it cannot describe.
    startupGateSupport: 'unknown',
  }])
  assert.equal(r.rttHistory, null, 'and reports no round-trip history rather than an empty one')
})

test('usagePct absent is unknown, and zero is zero', () => {
  const r = classifyHealth(
    { ...LIVE, panels: [{ agentId: 'k', agentKey: 'kimi' }, { agentId: 'c', agentKey: 'claude', usagePct: 0 }] },
    null,
    200,
  )
  // The Kimi watcher carries no agentId, so setUsagePct is never called for it.
  // That em dash is the truth about the panel, not a hole in this reader.
  assert.equal(r.panels[0]?.usagePct, null)
  assert.equal(r.panels[1]?.usagePct, 0)
})

test('rttHistory is only read under the shipped name', () => {
  // `rttHistory` was a defensive second spelling carried while the two branches
  // could not see each other. `pongRttHistory` is what the daemon sends.
  const r = classifyHealth({ connected: true, rttHistory: [1, 2, 3] } as never, null, 200)
  assert.equal(r.rttHistory, null)
})

test('the project column is the cwd leaf, because the card is 368pt wide', () => {
  assert.equal(projectFromCwd('/Users/me/Development/jerico'), 'jerico')
  assert.equal(projectFromCwd('/Users/me/Development/jerico/'), 'jerico')
  assert.equal(projectFromCwd('/'), '/')
  assert.equal(projectFromCwd(null), null)
})

test('hook state is still reachable, and the refusal is still annotated apart from it', () => {
  // This guard used to pin the markup — a `>turn hooks<` heading and the
  // `hookRefusalLabel` helper. Both are gone: the standalone register appeared
  // nowhere in the approved design and cost 14% of the card restating names, so
  // the reading folded onto the panel row (drawn only when NOT settled-healthy)
  // and the full roster moved to the nested detail view. The INTENT is what this
  // guard was for, and it still holds — asserted against the new surfaces.
  const card = readFileSync(new URL('../src/renderer/src/routes/Popover.svelte', import.meta.url), 'utf8')
  const detail = readFileSync(new URL('../src/renderer/src/lib/PanelsPanel.svelte', import.meta.url), 'utf8')

  // 1. The row can say something about a panel, and there is a way to the detail.
  // Both halves, or the mutation "always false" would still match: the row has
  // to be able to draw marks AND to decide to.
  assert.match(card, /\{#if row\.marks\.length > 0\}/, 'the row must draw its marks when it has some')
  assert.match(card, /\{#each row\.marks as mark/, 'and must draw each of them')
  assert.match(card, /setView\('panels'\)/, 'and there must be a route to the full roster')

  // 2. Hook state is drawn in full somewhere, with every state named.
  for (const state of ['configured', 'not configured', 'malformed config', 'could not determine']) {
    assert.ok(detail.includes(state), `the detail view must name the hook state ${state}`)
  }

  // 3. The refusal is a SEPARATE annotation, not folded into the hook state —
  //    a hook can read `present_ok` and still have been refused, and the row
  //    has to say which.
  assert.match(detail, /install refused/, 'the refusal needs its own term in the detail view')
  assert.match(detail, /hookInstallRefused/)
})
