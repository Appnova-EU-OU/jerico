/**
 * The 8-panel cap was wrong twice over, and both errors are pinned here.
 *
 * It was not the number the machine can carry — the user routinely ran ~30 panels
 * on a larger machine, and measurement on a 16 GB one put agent processes at
 * ~200 MB resident each. And it guarded the wrong resource: the known /dev/ptmx
 * leak accrues per panel KILLED over a daemon's lifetime, not per panel alive, so
 * a concurrency cap never constrained it. Measured live while investigating:
 * 16 ptmx fds against 4 live panels, 20 of a 511 system ceiling in use — the fds
 * tracked churn, not concurrency.
 */
import { describe, expect, test } from 'bun:test'
import {
  MAX_ACTIVE_PANELS,
  MAX_ACTIVE_PANELS_CEILING,
  panelCapacityForMachine,
  resolveActivePanelCap,
} from '../types.js'

const GB = 1024 * 1024 * 1024

describe('panel capacity is a property of the machine', () => {
  test('a bigger machine gets a bigger budget — the whole point', () => {
    const small = panelCapacityForMachine(16 * GB)
    const large = panelCapacityForMachine(64 * GB)
    expect(large).toBeGreaterThan(small)
  })

  test('a 64GB machine comfortably clears the ~30 the user actually ran', () => {
    // The reported real-world usage the old constant of 8 was refusing.
    expect(panelCapacityForMachine(64 * GB)).toBeGreaterThanOrEqual(30)
  })

  test('a 16GB machine lands near the measured binding point, not at 8', () => {
    const cap = panelCapacityForMachine(16 * GB)
    expect(cap).toBeGreaterThan(MAX_ACTIVE_PANELS)
    // Measurement put the practical ceiling around 20-25 on this size, so a
    // budget wildly above that would trade a clear refusal for swap death.
    expect(cap).toBeLessThanOrEqual(25)
  })

  test('a tiny machine never drops below the floor', () => {
    // A refusal at the floor is recoverable; a budget of zero is a daemon that
    // can never spawn anything and reports it as capacity.
    expect(panelCapacityForMachine(1 * GB)).toBe(MAX_ACTIVE_PANELS)
    expect(panelCapacityForMachine(0)).toBe(MAX_ACTIVE_PANELS)
    expect(panelCapacityForMachine(Number.NaN)).toBe(MAX_ACTIVE_PANELS)
    expect(panelCapacityForMachine(-1)).toBe(MAX_ACTIVE_PANELS)
  })

  test('an absurd machine is still bounded — a typo must not mean unlimited', () => {
    expect(panelCapacityForMachine(100_000 * GB)).toBe(MAX_ACTIVE_PANELS_CEILING)
  })
})

describe('resolving an advertised or configured cap', () => {
  test('a sane advertised value is honoured', () => {
    expect(resolveActivePanelCap(30)).toBe(30)
    expect(resolveActivePanelCap(1)).toBe(1)
  })

  test('an older daemon that advertises nothing falls back to the floor, not to unlimited', () => {
    // The important half: silence must never mean "no limit". A refusal with a
    // clear error is recoverable; silent resource exhaustion kills every panel
    // and says nothing.
    expect(resolveActivePanelCap(undefined)).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap(null)).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap('30')).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap(Number.NaN)).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap(Infinity)).toBe(MAX_ACTIVE_PANELS)
  })

  test('a nonsense or hostile value cannot disable the guard', () => {
    expect(resolveActivePanelCap(0)).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap(-5)).toBe(MAX_ACTIVE_PANELS)
    expect(resolveActivePanelCap(9_999_999)).toBe(MAX_ACTIVE_PANELS_CEILING)
  })

  test('a fractional value is floored rather than rejected', () => {
    expect(resolveActivePanelCap(12.9)).toBe(12)
  })
})
