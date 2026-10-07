import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyPanel, panelsRegister, MAX_BORING_PANEL_ROWS,
  type PopoverPanel,
} from '../src/main/utils/popover-model.ts'

/** `??` would silently discard the case most of these tests are about: an
 *  explicit `hook: null` is the unknown reading, and `null ?? default` is the
 *  default. So every nullable field is keyed on presence, not on falsiness. */
function panel(over: Partial<PopoverPanel> = {}): PopoverPanel {
  const pick = <K extends keyof PopoverPanel>(k: K, fallback: PopoverPanel[K]): PopoverPanel[K] =>
    k in over ? (over[k] as PopoverPanel[K]) : fallback
  return {
    key: pick('key', 'k1'),
    agent: pick('agent', 'claude'),
    project: pick('project', 'jerico'),
    cwd: pick('cwd', '/Users/x/jerico'),
    contextPct: pick('contextPct', null),
    hook: pick('hook', { configState: 'present_ok', hookInstallRefused: null }),
    startupGate: pick('startupGate', { phase: 'ready', gate: 'workspace_trust', reason: null, observedAt: 0 }),
    startupGateSupport: pick('startupGateSupport', 'monitored'),
  }
}

// ── §2, the honesty table — every row of it ──────────────────────────────

test('settled-healthy is the ONLY silent state', () => {
  const r = classifyPanel(panel())
  assert.equal(r.health, 'healthy')
  assert.deepEqual(r.marks, [])
})

test('an unsupported hook is silent — a capability answer, not a fault', () => {
  const r = classifyPanel(panel({ hook: { configState: 'unsupported_trust_required', hookInstallRefused: null } }))
  assert.equal(r.health, 'healthy')
  assert.deepEqual(r.marks, [])
})

test('a null gate is drawn as unknown, never omitted', () => {
  const r = classifyPanel(panel({ startupGate: null }))
  assert.equal(r.health, 'unknown')
  assert.ok(r.marks.length > 0, 'an unknown gate must produce a mark')
})

test('a null hook is drawn as unknown, never omitted', () => {
  const r = classifyPanel(panel({ hook: null }))
  assert.equal(r.health, 'unknown')
  assert.ok(r.marks.length > 0)
})

test("hook 'unknown' is unknown, not healthy — the state that would decay the rule", () => {
  const r = classifyPanel(panel({ hook: { configState: 'unknown', hookInstallRefused: null } }))
  assert.equal(r.health, 'unknown')
  assert.ok(r.marks.length > 0)
})

test('a checking gate is unknown, not ready', () => {
  const r = classifyPanel(panel({ startupGate: { phase: 'checking', gate: 'workspace_trust', reason: null, observedAt: 0 } }))
  assert.equal(r.health, 'unknown')
})

test('blocked and attention are faults, with their words', () => {
  const b = classifyPanel(panel({ startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } }))
  assert.equal(b.health, 'fault')
  assert.ok(b.marks.some((m) => m.text === 'TRUST BLOCKED' && m.tone === 'bad'))
  const a = classifyPanel(panel({ startupGate: { phase: 'attention', gate: 'workspace_trust', reason: null, observedAt: 0 } }))
  assert.equal(a.health, 'fault')
})

test('absent and malformed hooks are faults', () => {
  assert.equal(classifyPanel(panel({ hook: { configState: 'absent', hookInstallRefused: null } })).health, 'fault')
  assert.equal(classifyPanel(panel({ hook: { configState: 'malformed', hookInstallRefused: null } })).health, 'fault')
})

test('a refusal is a fault even when the hook state alone would be quiet', () => {
  const r = classifyPanel(panel({ hook: { configState: 'present_ok', hookInstallRefused: { status: 'declined', at: 1 } } }))
  assert.equal(r.health, 'fault')
  assert.ok(r.marks.some((m) => m.text.includes('install refused')))
})

test('two independent exceptions are drawn as two marks, not collapsed', () => {
  const r = classifyPanel(panel({
    startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 },
    hook: { configState: 'absent', hookInstallRefused: null },
  }))
  assert.equal(r.marks.length, 2)
})

// ── the register groups by PROJECT, not by panel ─────────────────────────

function many(n: number, over: Partial<PopoverPanel> = {}): PopoverPanel[] {
  return Array.from({ length: n }, (_, i) => panel({ key: `k${i}`, ...over }))
}

const J = '/Users/me/jerico'
const O = '/Users/me/orca'

test('N = 0 says nothing rather than drawing an empty register', () => {
  const r = panelsRegister([])
  assert.deepEqual(r.rows, [])
  assert.equal(r.coverage, null)
  assert.equal(r.totalPanels, 0)
})

test('one row per project, with the panel count on it', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J }), panel({ key: 'b', cwd: J }), panel({ key: 'c', cwd: O }),
  ])
  assert.equal(r.rows.length, 2)
  assert.deepEqual(r.rows.map((x) => [x.project, x.panels]), [['jerico', 2], ['orca', 1]])
  assert.equal(r.totalPanels, 3)
})

test('grouping is on the full cwd — two checkouts sharing a leaf stay two rows', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: '/Users/me/work/jerico' }),
    panel({ key: 'b', cwd: '/Users/me/fork/jerico' }),
  ])
  assert.equal(r.rows.length, 2, 'a shared leaf name must not merge two directories')
  assert.deepEqual(r.rows.map((x) => x.project), ['jerico', 'jerico'])
})

test('panels with no reported directory get their own honest row, never dropped', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J }), panel({ key: 'b', cwd: null }), panel({ key: 'c', cwd: null })])
  const none = r.rows.find((x) => x.project === null)
  assert.ok(none, 'the unreported group must have a row')
  assert.equal(none.panels, 2)
  assert.equal(none.cwd, null)
  assert.equal(r.rows.reduce((n, x) => n + x.panels, 0), 3, 'every panel is accounted for')
})

test('the unreported group sorts last among equals', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: null }), panel({ key: 'b', cwd: J })])
  assert.deepEqual(r.rows.map((x) => x.project), ['jerico', null])
})

test('a project row carries the highest context reading in the group', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J, contextPct: 42 }),
    panel({ key: 'b', cwd: J, contextPct: 91 }),
    panel({ key: 'c', cwd: J, contextPct: null }),
  ])
  assert.equal(r.rows[0]?.topContextPct, 91)
})

test('a group with no readings reports null, not zero', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J, contextPct: null })])
  assert.equal(r.rows[0]?.topContextPct, null)
})

// ── aggregated marks: counted, and one mark per cause ─────────────────────

test('a healthy project says nothing at all', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J }), panel({ key: 'b', cwd: J })])
  assert.equal(r.rows[0]?.health, 'healthy')
  assert.deepEqual(r.rows[0]?.marks, [])
})

test('faults are counted, not named — the row stands for several panels', () => {
  const blocked = { phase: 'blocked' as const, gate: 'workspace_trust' as const, reason: null, observedAt: 0 }
  const r = panelsRegister([
    panel({ key: 'a', cwd: J, startupGate: blocked }),
    panel({ key: 'b', cwd: J, startupGate: blocked }),
    panel({ key: 'c', cwd: J }),
  ])
  assert.equal(r.rows[0]?.health, 'fault')
  assert.ok(r.rows[0]?.marks.some((m) => m.text === '2 trust blocked' && m.tone === 'bad'))
})

test('two different causes make two marks, because they need two fixes', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J, startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } }),
    panel({ key: 'b', cwd: J, hook: { configState: 'absent', hookInstallRefused: null } }),
  ])
  const texts = r.rows[0]?.marks.map((m) => m.text) ?? []
  assert.ok(texts.includes('1 trust blocked'), texts.join(' / '))
  assert.ok(texts.includes('1 hook not configured'), texts.join(' / '))
})

test('an unknown reading is never silent at the project level either', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J, hook: null })])
  assert.equal(r.rows[0]?.health, 'unknown')
  assert.ok(r.rows[0]?.marks.some((m) => m.text.includes('hook unknown')))
})

test('ONE unknown panel among healthy ones still makes the project unknown', () => {
  // The mixed group is the case a single-panel test cannot see: `some` and
  // `every` agree when the group has one member, and only this shape catches a
  // group that reports "healthy" because most of it is.
  const r = panelsRegister([
    panel({ key: 'ok1', cwd: J }),
    panel({ key: 'ok2', cwd: J }),
    panel({ key: 'unk', cwd: J, hook: null }),
  ])
  assert.equal(r.rows[0]?.health, 'unknown', 'a majority of healthy panels does not make the group healthy')
  assert.ok(r.rows[0]?.marks.some((m) => m.text === '1 hook unknown'))
  assert.equal(r.alert, '1 unknown')
})

test('a group is a fault if ANY panel is, even beside healthy ones', () => {
  const r = panelsRegister([
    ...Array.from({ length: 9 }, (_, i) => panel({ key: `ok${i}`, cwd: J })),
    panel({ key: 'bad', cwd: J, hook: { configState: 'malformed', hookInstallRefused: null } }),
  ])
  assert.equal(r.rows[0]?.health, 'fault')
  assert.ok(r.rows[0]?.marks.some((m) => m.text === '1 hook malformed'))
})

test('an unsupported hook raises nothing — it is a capability answer', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J, hook: { configState: 'unsupported_trust_required', hookInstallRefused: null } })])
  assert.equal(r.rows[0]?.health, 'healthy')
  assert.deepEqual(r.rows[0]?.marks, [])
})

// ── scaling: rows follow projects, and faults are never capped ────────────

test('40 panels in one project is ONE row', () => {
  const r = panelsRegister(many(40, { cwd: J }))
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0]?.panels, 40)
  assert.equal(r.hiddenProjects, 0)
})

test('boring project rows are capped and the tail counts what it hid', () => {
  const panels = Array.from({ length: 10 }, (_, i) => panel({ key: `k${i}`, cwd: `/p/proj${i}` }))
  const r = panelsRegister(panels)
  assert.equal(r.rows.length, MAX_BORING_PANEL_ROWS)
  assert.equal(r.hiddenProjects, 10 - MAX_BORING_PANEL_ROWS)
  assert.equal(r.hiddenPanels, 10 - MAX_BORING_PANEL_ROWS)
})

test('a faulty project is NEVER capped away, however many boring ones there are', () => {
  const boring = Array.from({ length: 12 }, (_, i) => panel({ key: `b${i}`, cwd: `/p/proj${i}` }))
  const bad = panel({ key: 'bad', cwd: '/p/zzz-last-alphabetically', startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } })
  const r = panelsRegister([...boring, bad])
  assert.ok(r.rows.some((x) => x.cwd === '/p/zzz-last-alphabetically'), 'the faulty project must be drawn')
  assert.equal(r.rows[0]?.health, 'fault', 'and it must be first')
  assert.equal(r.rows.filter((x) => x.health === 'healthy').length, MAX_BORING_PANEL_ROWS)
})

test('worst project sorts first', () => {
  const r = panelsRegister([
    panel({ key: 'ok', cwd: '/p/aaa' }),
    panel({ key: 'unk', cwd: '/p/bbb', hook: null }),
    panel({ key: 'bad', cwd: '/p/ccc', startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } }),
  ])
  assert.deepEqual(r.rows.map((x) => x.health), ['fault', 'unknown', 'healthy'])
})

test('among equals, the busier project sorts first', () => {
  // The names fight the panel count on purpose: `aaa` wins alphabetically and
  // loses on panels, so a passing assertion can only come from the count. With
  // `big`/`small` the two rules happened to agree and the test proved nothing.
  const r = panelsRegister([
    panel({ key: 'a', cwd: '/p/aaa' }),
    panel({ key: 'b', cwd: '/p/zzz' }), panel({ key: 'c', cwd: '/p/zzz' }),
  ])
  assert.deepEqual(r.rows.map((x) => x.project), ['zzz', 'aaa'])
})

// ── the coverage line still accounts for every PANEL ─────────────────────

test('coverage counts panels, not projects, including capped-away ones', () => {
  const panels = Array.from({ length: 10 }, (_, i) => panel({ key: `k${i}`, cwd: `/p/proj${i}` }))
  const r = panelsRegister(panels)
  assert.equal(r.hiddenProjects, 4)
  assert.match(r.coverage!, /gate 10 ready/)
  assert.match(r.coverage!, /10 configured/)
})

test('coverage does not grow with N', () => {
  const a = panelsRegister(many(4, { cwd: J })).coverage!
  const b = panelsRegister(many(128, { cwd: J })).coverage!
  assert.equal(a.split('\n').length, 1)
  assert.equal(b.split('\n').length, 1)
  assert.ok(Math.abs(a.length - b.length) < 8, 'coverage length must be ~constant')
})

test('an unknown hook is reported as "not", never folded into configured', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J }), panel({ key: 'u', cwd: J, hook: { configState: 'unknown', hookInstallRefused: null } })])
  assert.match(r.coverage!, /1 configured/)
  assert.match(r.coverage!, /1 not/)
})

test('coverage counts an unsupported hook as n/a — neither configured nor a fault', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J }),
    panel({ key: 's', cwd: J, hook: { configState: 'unsupported_trust_required', hookInstallRefused: null } }),
  ])
  assert.match(r.coverage!, /1 configured/)
  assert.match(r.coverage!, /1 n\/a/)
  assert.doesNotMatch(r.coverage!, /not/, 'an unsupported hook is not a missing one')
  assert.equal(r.faults, 0)
})

// ── the alert suffix ─────────────────────────────────────────────────────

test('the register contributes an alert suffix, and never a count of its own', () => {
  const r = panelsRegister([panel({ key: 'a', cwd: J }), panel({ key: 'b', cwd: J, startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } })])
  assert.equal(r.alert, '1 fault')
  // The phase owns the count. A register that produced "2 running" would say
  // "running" about a stopped daemon's leftover rows.
  assert.ok(!('count' in r), 'the register must not carry a count')
})

test('the alert counts PANELS, not projects', () => {
  const blocked = { phase: 'blocked' as const, gate: 'workspace_trust' as const, reason: null, observedAt: 0 }
  const r = panelsRegister([
    panel({ key: 'a', cwd: J, startupGate: blocked }),
    panel({ key: 'b', cwd: J, startupGate: blocked }),
  ])
  assert.equal(r.rows.length, 1)
  assert.equal(r.alert, '2 faults')
})

test('all-healthy adds no alert at all', () => {
  assert.equal(panelsRegister([panel({ key: 'a', cwd: J }), panel({ key: 'b', cwd: J })]).alert, null)
})

test('unknowns raise an alert when there are no faults', () => {
  assert.equal(panelsRegister([panel({ key: 'a', cwd: J, hook: null })]).alert, '1 unknown')
})

test('faults outrank unknowns in the alert', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J, hook: null }),
    panel({ key: 'b', cwd: J, startupGate: { phase: 'blocked', gate: 'workspace_trust', reason: null, observedAt: 0 } }),
  ])
  assert.equal(r.alert, '1 fault')
})

// ── an un-watched gate is silent; an un-reported one is not ──────────────

test('a panel the daemon does not watch says nothing about its gate', () => {
  // A shell has no startup to gate. Reporting that as "unknown" put a permanent
  // un-actionable mark on every project holding one.
  const r = classifyPanel(panel({ startupGate: null, startupGateSupport: 'not_applicable' }))
  assert.equal(r.health, 'healthy')
  assert.deepEqual(r.marks, [])
})

test('a monitored panel with no gate yet is still unknown', () => {
  const r = classifyPanel(panel({ startupGate: null, startupGateSupport: 'monitored' }))
  assert.equal(r.health, 'unknown')
  assert.ok(r.marks.some((m) => m.text.startsWith('gate')))
})

test("a daemon too old to say is NOT silenced — 'unknown' support stays unknown", () => {
  // The load-bearing case. Treating an old daemon's silence as "not applicable"
  // would hide a real blocked gate behind a version difference.
  const r = classifyPanel(panel({ startupGate: null, startupGateSupport: 'unknown' }))
  assert.equal(r.health, 'unknown')
  assert.ok(r.marks.some((m) => m.text.startsWith('gate')))
})

test('an un-watched panel that somehow reports a fault is still a fault', () => {
  // support only decides what an ABSENT gate means. A present one always speaks.
  const r = classifyPanel(panel({
    startupGateSupport: 'not_applicable',
    startupGate: { phase: 'blocked', gate: 'authentication', reason: null, observedAt: 0 },
  }))
  assert.equal(r.health, 'fault')
})

test('coverage counts un-watched gates as n/a, never as "not ready"', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J }),
    panel({ key: 'sh', cwd: J, startupGate: null, startupGateSupport: 'not_applicable' }),
  ])
  assert.match(r.coverage!, /gate 1 ready \/ 1 n\/a/)
  assert.doesNotMatch(r.coverage!, /1 not/)
  assert.equal(r.unknowns, 0)
})

test('an old daemon still counts toward "not", not toward n/a', () => {
  const r = panelsRegister([
    panel({ key: 'a', cwd: J }),
    panel({ key: 'old', cwd: J, startupGate: null, startupGateSupport: 'unknown' }),
  ])
  assert.match(r.coverage!, /1 not/)
  assert.doesNotMatch(r.coverage!, /n\/a/)
})

test('marksAgreeWithCauses — a silent panel contributes no cause to its project row', () => {
  // The two encodings of "what is worth saying about a panel" — classifyPanel's
  // marks and panelsRegister's CAUSES table — drifted once, and the row went on
  // reporting `1 gate unknown` about a shell after classifyPanel had stopped.
  // This ties them: whatever classifyPanel calls healthy-and-silent must add
  // nothing to the row.
  const cases: Partial<PopoverPanel>[] = [
    { startupGate: null, startupGateSupport: 'not_applicable' },
    { hook: { configState: 'unsupported_trust_required', hookInstallRefused: null } },
    {},
    { startupGate: null, startupGateSupport: 'not_applicable',
      hook: { configState: 'unsupported_no_config_hook_surface', hookInstallRefused: null } },
  ]
  for (const over of cases) {
    const p = panel({ cwd: J, ...over })
    const solo = classifyPanel(p)
    const row = panelsRegister([p]).rows[0]
    assert.equal(row?.marks.length === 0, solo.marks.length === 0,
      `disagreement for ${JSON.stringify(over)}: classifyPanel=${JSON.stringify(solo.marks)} row=${JSON.stringify(row?.marks)}`)
    assert.equal(row?.health, solo.health)
  }
})

test('a shell adds nothing to its project row at all', () => {
  const r = panelsRegister([
    panel({ key: 'c', cwd: J }),
    panel({ key: 'sh', cwd: J, startupGate: null, startupGateSupport: 'not_applicable',
      hook: { configState: 'unsupported_no_config_hook_surface', hookInstallRefused: null } }),
  ])
  assert.equal(r.rows.length, 1)
  assert.deepEqual(r.rows[0]?.marks, [], 'a project of healthy panels plus a shell says nothing')
  assert.equal(r.alert, null)
})
