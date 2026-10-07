/**
 * Pure PTY → WebSocket backpressure decision (issue #377).
 *
 * node-pty has no built-in flow control, so a fast child (e.g. Claude Code
 * emitting multi-KB/sec during tool use) can freely fill the WS send buffer.
 * When `ws.bufferedAmount` exceeds the high watermark we pause the PTY master
 * read; the OS pty buffer then fills and blocks the child's writes — applying
 * real backpressure. When the socket drains below the low watermark a paused
 * PTY is resumed.
 *
 * Extracted from ws/client.ts so the decision is unit-testable without pulling
 * in that module's connection-side-effect graph.
 */

export const PTY_HIGH_WATERMARK = 128 * 1024
export const PTY_LOW_WATERMARK = 32 * 1024

export type PtyBackpressureAction = 'pause' | 'resume' | 'none'

export interface PtyBackpressureInput {
  /** ws.bufferedAmount after the most recent send. */
  bufferedAmount: number
  /** Override high watermark (defaults to PTY_HIGH_WATERMARK). */
  highWatermark?: number
  /** Override low watermark (defaults to PTY_LOW_WATERMARK). */
  lowWatermark?: number
  /** Whether this agent's PTY is already paused for bufferedAmount reasons. */
  alreadyPaused: boolean
}

/**
 * Decide the backpressure action for the bufferedAmount gate only.
 * RTT-based throttling is a separate concern and handled by the caller.
 */
export function evaluatePtyBackpressure(input: PtyBackpressureInput): PtyBackpressureAction {
  const high = input.highWatermark ?? PTY_HIGH_WATERMARK
  const low = input.lowWatermark ?? PTY_LOW_WATERMARK

  if (input.bufferedAmount > high && !input.alreadyPaused) return 'pause'
  if (input.bufferedAmount <= low && input.alreadyPaused) return 'resume'
  return 'none'
}
