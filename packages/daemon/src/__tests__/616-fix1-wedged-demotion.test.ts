import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { OrchestratorEventBroker } from '../events/broker.js'

describe('616 Fix 1 - wedged/detached demotion', () => {
  test('publish to wedged subscriber is refused (falls through to PTY)', () => {
    let nowMs = 0
    const broker = new OrchestratorEventBroker({ now: () => nowMs, hangAfterMs: 1000 })
    const sub = 'panel#42'
    const { lease } = broker.attach(sub)
    // publish first record, read it to update lastReadAt=0
    broker.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: 'first' })
    broker.read(sub, lease)
    expect(broker.wedgedSubscribers()).toEqual([])
    // advance past hang window
    nowMs = 2000
    expect(broker.wedgedSubscribers()).toContain(sub)
    const out = broker.publish(sub, { watchId: 'w2', idempotencyKey: 'k2', kind: 'k', payload: 'second' })
    expect(out.published).toBe(false)
    expect((out as { reason: string }).reason).toBe('no_subscriber')
  })

  test('publish to detached subscriber is refused', () => {
    const broker = new OrchestratorEventBroker()
    const sub = 'panel-detached#1'
    const { lease } = broker.attach(sub)
    broker.publish(sub, { watchId: 'w1', idempotencyKey: 'k1', kind: 'k', payload: 'hello' })
    broker.detach(sub, lease)
    expect(broker.detachedSubscribers()).toContain(sub)
    const out = broker.publish(sub, { watchId: 'w2', idempotencyKey: 'k2', kind: 'k', payload: 'next' })
    expect(out.published).toBe(false)
  })

  test('start.ts wires wedged/detached detectors on a timer', () => {
    const src = readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf8')
    expect(src).toContain('wedgedSubscribers')
    expect(src).toContain('detachedSubscribers')
    // must be on a timer (setInterval or setTimeout) owned by same scope as broker
    const hasTimer = src.includes('setInterval') && src.includes('wedgedSubscribers')
    expect(hasTimer).toBe(true)
  })
})
