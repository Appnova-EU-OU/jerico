/**
 * #616 layer 2 — is the gate actually REACHED?
 *
 * The gate itself is covered by `prompt-gate.test.ts`. This file exists because
 * this repo's most repeated defect is a mechanism that works while the caller's
 * real path never reaches it — it has happened four times in this issue alone,
 * most recently a CLI polling a URL that did not exist. Unit-testing the gate
 * proves nothing about whether a notice passes through it.
 *
 * Source-level rather than behavioural, and deliberately so: exercising the real
 * path needs a live PTY, a WS peer and a daemon process. What can be checked
 * cheaply and repeatably is that the wiring EXISTS and is shaped correctly, and
 * that the one distinction it depends on — notice versus payload — is preserved
 * at both ends.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const daemonClient = readFileSync(new URL('../ws/client.ts', import.meta.url), 'utf8')
const daemonTypes  = readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8')

/**
 * Source with `//` line comments removed.
 *
 * Both directions matter. A comment can BREAK a windowed assertion by pushing
 * the real code out of range — and, worse, it can SATISFY one by containing the
 * exact text being looked for. The second failure mode is silent, so every
 * structural assertion below runs against this view rather than the raw file.
 */
function code(src: string): string {
  return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

describe('#616 layer 2 wiring', () => {
  test('the daemon instantiates the gate and imports it', () => {
    expect(daemonClient).toContain("from '../events/prompt-gate.js'")
    expect(daemonClient).toMatch(/const promptGate = new PromptGate\(/)
  })

  test('the gate is fed from the PTY output path, not from a side channel', () => {
    // It must sit with recordOutput: that is the one place every chunk passes,
    // including chunks dropped for backpressure. A gate reading a stale tail
    // would release a notice into a half-typed line.
    const idx = daemonClient.indexOf('promptGate.noteOutput(')
    expect(idx).toBeGreaterThan(-1)
    const window = daemonClient.slice(Math.max(0, idx - 1200), idx)
    expect(window).toContain('recordOutput(')
  })

  test('held notices are released from the same output path', () => {
    expect(daemonClient).toContain('promptGate.drainReady(')
    expect(daemonClient).toContain('notice.released')
  })

  test('a released notice is written in the SAME encoding it arrived in', () => {
    // This is the assertion the first version of these tests lacked: it checked
    // that the release wire EXISTED and never what flowed through it. The write
    // decoded base64 to text and handed it to manager.write, which base64-decodes
    // its own argument (pty/manager.ts) — so a released notice arrived in the
    // orchestrator's input line as a run of garbage bytes.
    const src = code(daemonClient)
    const idx = src.indexOf('promptGate.drainReady(')
    expect(idx).toBeGreaterThan(-1)
    const window = src.slice(idx, idx + 500)
    const call = /manager\.write\([^\n]*/.exec(window)
    expect(call).not.toBeNull()
    const args = call![0]
    // No re-encoding on this path: manager.write owns the decode.
    expect(args).not.toContain('base64')
    expect(args).not.toContain('Buffer.from')
    // Same three arguments the un-held path uses, for the same reasons.
    expect(args).toContain('held.data')
    expect(args).toContain("'orchestrator'")
    expect(args).toContain('raw: true')
  })

  test('the released write matches the un-held write, argument for argument', () => {
    // A correspondence, asserted in the direction that can actually go wrong:
    // if the two paths ever disagree about encoding or source again, this fails.
    const src = code(daemonClient)
    const unheld = /manager\.write\(msg\.agentId, msg\.data, 'orchestrator', \{ raw: true \}\)/
    expect(src).toMatch(unheld)
    const idx = src.indexOf('promptGate.drainReady(')
    const window = src.slice(idx, idx + 500)
    expect(window).toMatch(/manager\.write\(msg\.agentId, held\.data, 'orchestrator', \{ raw: true \}\)/)
  })

  test('the write path consults the gate, and only for notices', () => {
    const idx = daemonClient.indexOf('promptGate.hold(')
    expect(idx).toBeGreaterThan(-1)
    const window = daemonClient.slice(Math.max(0, idx - 5000), idx)
    // The guard must require the notice flag. Without it, every task dispatch
    // would be held too, delaying every run to fix a problem it does not have.
    expect(window).toContain('msg.notice === true')
  })

  test('a held queue blocks later notices, so order cannot invert', () => {
    const idx = daemonClient.indexOf('promptGate.hold(')
    const window = daemonClient.slice(Math.max(0, idx - 900), idx)
    expect(window).toContain('promptGate.hasHeld(')
  })

  test('the notice flag exists in the daemon protocol', () => {
    expect(daemonTypes).toMatch(/type: 'input'[\s\S]{0,400}notice\?: boolean/)
  })

  test('a gate failure cannot break output delivery', () => {
    // Losing the hold is strictly better than losing the panel.
    const src = code(daemonClient)
    const idx = src.indexOf('promptGate.noteOutput(')
    const window = src.slice(Math.max(0, idx - 400), idx + 1200)
    expect(window).toContain('catch')
    expect(window).toContain('prompt_gate.failed')
  })
})
