import { describe, test, expect } from 'bun:test'
import {
  evaluatePtyBackpressure,
  PTY_HIGH_WATERMARK,
  PTY_LOW_WATERMARK,
} from '../ws/pty-backpressure'

describe('evaluatePtyBackpressure (#377)', () => {
  test('pauses when bufferedAmount exceeds high watermark and not already paused', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: PTY_HIGH_WATERMARK + 1, alreadyPaused: false }),
    ).toBe('pause')
  })

  test('does not re-pause an already-paused agent even above high watermark', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: PTY_HIGH_WATERMARK * 2, alreadyPaused: true }),
    ).toBe('none')
  })

  test('resumes when bufferedAmount drains below low watermark while paused', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: PTY_LOW_WATERMARK - 1, alreadyPaused: true }),
    ).toBe('resume')
  })

  test('does not resume when not paused, even below low watermark', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: 0, alreadyPaused: false }),
    ).toBe('none')
  })

  test('no action in the hysteresis band (between low and high, paused)', () => {
    const mid = (PTY_LOW_WATERMARK + PTY_HIGH_WATERMARK) / 2
    expect(evaluatePtyBackpressure({ bufferedAmount: mid, alreadyPaused: true })).toBe('none')
  })

  test('no action in the hysteresis band (between low and high, not paused)', () => {
    const mid = (PTY_LOW_WATERMARK + PTY_HIGH_WATERMARK) / 2
    expect(evaluatePtyBackpressure({ bufferedAmount: mid, alreadyPaused: false })).toBe('none')
  })

  test('boundary: exactly high watermark does not pause', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: PTY_HIGH_WATERMARK, alreadyPaused: false }),
    ).toBe('none')
  })

  test('boundary: exactly low watermark resumes a paused agent', () => {
    expect(
      evaluatePtyBackpressure({ bufferedAmount: PTY_LOW_WATERMARK, alreadyPaused: true }),
    ).toBe('resume')
  })

  test('honors custom watermarks', () => {
    expect(
      evaluatePtyBackpressure({
        bufferedAmount: 5000,
        highWatermark: 4096,
        lowWatermark: 1024,
        alreadyPaused: false,
      }),
    ).toBe('pause')
  })
})
