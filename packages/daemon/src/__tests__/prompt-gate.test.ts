/**
 * #616 layer 2 — the global fix, tested against the failure it exists to stop.
 *
 * The user's sentence was broken repeatedly during this work: they were typing
 * "dae…" and a notice landed in the middle of it. Every test here is built from
 * that moment rather than from an abstraction of it.
 */
import { describe, expect, test } from 'bun:test'
import { PromptGate, promptIsClean, HOLD_DEADLINE_MS, TAIL_BYTES } from '../events/prompt-gate.js'

const A = 'orch-panel'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('#616 prompt gate — when a write is safe', () => {
  test('an empty prompt is safe; a prompt carrying typed text is not', () => {
    expect(promptIsClean('\n❯ ')).toBe(true)
    expect(promptIsClean('\n> ')).toBe(true)
    expect(promptIsClean('\nuser@mac jerico % ')).toBe(true)

    // The exact moment the user's sentence was broken.
    expect(promptIsClean('\n❯ dae')).toBe(false)
    expect(promptIsClean('\n❯ prod ortamda mı test ediyorsun')).toBe(false)
  })

  test('a working panel is not safe either — output is still arriving', () => {
    expect(promptIsClean('\n• Working (5s • esc to interrupt)')).toBe(false)
    expect(promptIsClean('\n⏺ Bash(bun test)')).toBe(false)
  })

  test('ANSI and carriage returns do not fool it', () => {
    expect(promptIsClean('\x1b[2K\x1b[1G❯ ')).toBe(true)
    expect(promptIsClean('\x1b[2K\x1b[1G❯ half-typed')).toBe(false)
    expect(promptIsClean('❯ \r')).toBe(true)
  })

  test('no observation is not treated as safe', () => {
    // An empty tail means nothing was seen, which is not evidence of an empty
    // prompt. Guessing "safe" here is how a notice lands mid-sentence.
    expect(promptIsClean('')).toBe(false)
  })
})

describe('#616 prompt gate — holding and releasing', () => {
  test('a notice is held while the user is mid-sentence, and released when they submit', () => {
    const g = new PromptGate()
    g.noteOutput(A, '\n❯ dae')
    expect(g.decide(A)).toEqual({ action: 'hold', reason: 'prompt_dirty' })

    g.hold(A, { data: 'notice-1' })
    expect(g.drainReady(A)).toEqual([])          // still typing

    // The user hits enter; the panel works, then returns to an empty prompt.
    g.noteOutput(A, '\n• Working…\n')
    expect(g.drainReady(A)).toEqual([])
    g.noteOutput(A, '\n❯ ')

    const ready = g.drainReady(A)
    expect(ready).toHaveLength(1)
    expect(ready[0]!.data).toBe('notice-1')
    expect(g.hasHeld(A)).toBe(false)
  })

  test('the first notice on an unobserved panel is not stalled forever', () => {
    const g = new PromptGate()
    // Nothing has been seen for this panel yet. Holding on no evidence would
    // delay the very first notice indefinitely.
    expect(g.decide(A)).toEqual({ action: 'write' })
  })

  test('order is preserved — a younger notice never overtakes an older one', () => {
    const g = new PromptGate()
    g.noteOutput(A, '\n❯ typing')
    g.hold(A, { data: 'first' })
    g.hold(A, { data: 'second' })
    g.hold(A, { data: 'third' })

    g.noteOutput(A, '\n❯ ')
    expect(g.drainReady(A).map(w => w.data)).toEqual(['first', 'second', 'third'])
  })

  test('a prompt that never clears does not swallow the notice', () => {
    const c = clock()
    const g = new PromptGate({ now: c.now })
    g.noteOutput(A, '\n❯ a half-written thought left on screen')
    g.hold(A, { data: 'notice-1' })

    expect(g.drainReady(A)).toEqual([])
    c.advance(HOLD_DEADLINE_MS - 1)
    expect(g.drainReady(A)).toEqual([])

    // Past the deadline it goes out anyway. Interrupting a sentence is bad;
    // withholding a notice forever is the same failure as losing it.
    c.advance(2)
    const ready = g.drainReady(A)
    expect(ready).toHaveLength(1)
    expect(ready[0]!.data).toBe('notice-1')
  })

  test('the forced write says why, so a late notice is explicable', () => {
    const c = clock()
    const g = new PromptGate({ now: c.now })
    g.noteOutput(A, '\n❯ still typing')
    const heldSince = c.now()
    c.advance(HOLD_DEADLINE_MS)

    expect(g.decide(A, heldSince)).toEqual({
      action: 'write', forced: true, reason: 'hold_deadline_exceeded',
    })
  })

  test('the deadline is per notice, so an older one is released first', () => {
    const c = clock()
    const g = new PromptGate({ now: c.now })
    g.noteOutput(A, '\n❯ typing')

    g.hold(A, { data: 'old' })
    c.advance(HOLD_DEADLINE_MS)
    g.hold(A, { data: 'new' })

    // 'old' has aged out, 'new' has not — and draining stops at 'new' rather
    // than skipping it, so order survives.
    expect(g.drainReady(A).map(w => w.data)).toEqual(['old'])
    expect(g.heldCount(A)).toBe(1)
  })

  test('the tail is bounded — a chatty panel cannot grow it without limit', () => {
    const g = new PromptGate()
    for (let i = 0; i < 500; i++) g.noteOutput(A, 'x'.repeat(100))

    // Asserting the retained size, not just that the gate still answers: the
    // first version of this test checked only that a clean prompt arriving after
    // 50KB of noise was recognised, which passes with an unbounded tail. A
    // mutation removing the bound survived it.
    expect(g.tailBytes(A)).toBeLessThanOrEqual(TAIL_BYTES)

    // And it answers on the most recent bytes.
    g.noteOutput(A, '\n❯ ')
    expect(g.decide(A)).toEqual({ action: 'write' })
    expect(g.tailBytes(A)).toBeLessThanOrEqual(TAIL_BYTES)
  })

  test('forgetting a panel clears both its tail and its queue', () => {
    const g = new PromptGate()
    g.noteOutput(A, '\n❯ typing')
    g.hold(A, { data: 'notice' })
    g.forget(A)

    expect(g.hasHeld(A)).toBe(false)
    expect(g.decide(A)).toEqual({ action: 'write' })   // no observation again
  })

  test('diagnostics report how long the oldest notice has waited', () => {
    const c = clock()
    const g = new PromptGate({ now: c.now })
    expect(g.oldestHeldAgeMs(A)).toBeNull()

    g.noteOutput(A, '\n❯ typing')
    g.hold(A, { data: 'notice' })
    c.advance(5_000)
    expect(g.oldestHeldAgeMs(A)).toBe(5_000)
  })
})
