import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHealth } from '../src/main/utils/health-classify.ts'
import { panelsRegister, type PopoverPanel } from '../src/main/utils/popover-model.ts'

/**
 * The gate kinds the wire defines. Written out rather than imported so this test
 * fails when the list and the shared union disagree — importing the same
 * constant the code under test uses would make the assertion vacuous.
 */
const WIRE_GATE_KINDS = ['workspace_trust', 'authentication', 'unknown_startup'] as const

function healthWith(gate: string, phase = 'blocked'): unknown {
  return {
    connected: true,
    status: 'ok',
    panels: [{
      agentId: 'p1',
      agentKey: 'claude',
      cwd: '/Users/me/jerico',
      startupGate: { phase, gate, reason: 'authentication_required', observedAt: 1_700_000_000_000 },
      hook: { configState: 'present_ok' },
    }],
  }
}

for (const gate of WIRE_GATE_KINDS) {
  test(`a gate of kind '${gate}' survives the health classifier`, () => {
    const r = classifyHealth(healthWith(gate) as never, null, 200)
    const got = r.panels[0]?.startupGate
    assert.notEqual(got, null, `gate '${gate}' was dropped — the panel renders as unknown`)
    assert.equal(got?.gate, gate)
    assert.equal(got?.phase, 'blocked')
  })
}

test("a panel blocked on authentication reaches the register as a FAULT, not an unknown", () => {
  // The whole point of the fix: this state used to be discarded, so the popover
  // drew it as `gate —`, did not raise the fault alert, and did not sort it up.
  const r = classifyHealth(healthWith('authentication') as never, null, 200)
  const panel = r.panels[0]
  assert.ok(panel, 'the panel itself must survive')
  const view: PopoverPanel = {
    key: panel.agentId,
    agent: panel.agentKey,
    project: 'jerico',
    cwd: panel.cwd,
    contextPct: panel.usagePct,
    hook: panel.hook,
    startupGate: panel.startupGate,
  }
  const reg = panelsRegister([view])
  assert.equal(reg.rows[0]?.health, 'fault')
  assert.equal(reg.alert, '1 fault')
})

test('an off-contract gate kind is still rejected', () => {
  // The fix widens the accepted set to the wire union — it must not widen it to
  // "any string", or the validator stops validating.
  const r = classifyHealth(healthWith('something_invented') as never, null, 200)
  assert.equal(r.panels[0]?.startupGate, null)
})

test('a bad phase is still rejected, whatever the gate kind', () => {
  const r = classifyHealth(healthWith('authentication', 'not_applicable') as never, null, 200)
  assert.equal(r.panels[0]?.startupGate, null)
})

// ── how the classifier parses startupGateSupport ─────────────────────────

function healthWithSupport(support: unknown): unknown {
  const h = healthWith('workspace_trust') as { panels: Record<string, unknown>[] }
  if (support === undefined) delete h.panels[0].startupGateSupport
  else h.panels[0].startupGateSupport = support
  return h
}

test('the two real support values are carried through', () => {
  for (const v of ['monitored', 'not_applicable'] as const) {
    const r = classifyHealth(healthWithSupport(v) as never, null, 200)
    assert.equal(r.panels[0]?.startupGateSupport, v)
  }
})

test("a daemon that does not send the field reports 'unknown', not 'not_applicable'", () => {
  // The dangerous default. 'not_applicable' would silence every absent gate on
  // every daemon predating the field — including real blocked ones.
  const r = classifyHealth(healthWithSupport(undefined) as never, null, 200)
  assert.equal(r.panels[0]?.startupGateSupport, 'unknown')
})

test("a value the desktop does not recognise falls to 'unknown'", () => {
  for (const junk of ['something_else', 42, null, {}]) {
    const r = classifyHealth(healthWithSupport(junk) as never, null, 200)
    assert.equal(r.panels[0]?.startupGateSupport, 'unknown', `junk value ${JSON.stringify(junk)}`)
  }
})

test("the id-only fallback path reports 'unknown' support", () => {
  // An old daemon sending bare agentIds tells us nothing about monitoring.
  const r = classifyHealth({ connected: true, status: 'ok', agentIds: ['a1'] } as never, null, 200)
  assert.equal(r.panels.length, 1)
  assert.equal(r.panels[0]?.startupGateSupport, 'unknown')
})
