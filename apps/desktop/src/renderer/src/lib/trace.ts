/**
 * The heartbeat strip.
 *
 * A step plot of the last N pong round-trips against a FIXED 0–400 ms scale, so
 * the line means the same thing every time you look at it. Samples above the
 * ceiling clamp and are marked, rather than rescaling the chart — a strip that
 * rescales to fit its worst sample makes a bad minute look exactly like a good
 * one.
 *
 * Ported from design/01-tray-popover.html, with one thing the design could not
 * have: a `none` mode. The design's canvas always had samples because it
 * generated them. The daemon does not report round-trips yet, and a flat line
 * at zero would read as "every ping took no time at all", which is the opposite
 * of what is true.
 */

export type TraceMode = 'run' | 'break' | 'scan' | 'flat' | 'none'

/** The daemon pings every 15 s (KEEPALIVE_MS), so forty samples is ten minutes
 *  and the line steps four times a minute. */
export const TRACE_SAMPLES = 40
export const TRACE_CEILING_MS = 400

const MONO = '500 8.5px "IBM Plex Mono", ui-monospace, monospace'

export interface TraceOptions {
  mode: TraceMode
  /** Oldest first. Entries may be null where a pong is known to be missing. */
  series: (number | null)[]
  /** '#6fdca0' | '#ffb547' | '#f0655e' — the state colour, passed in so this
   *  file holds no palette of its own. */
  colour: string
  width: number
  height: number
  /** 0–1, only read in `scan` mode. */
  scanPhase: number
}

export function drawTrace(ctx: CanvasRenderingContext2D, o: TraceOptions): void {
  const { width: w, height: h, colour: col, mode } = o
  ctx.clearRect(0, 0, w, h)

  const padL = 15
  const padR = 72          // room for the RTT readout floating at the right
  const step = (w - padL - padR) / (TRACE_SAMPLES - 1)
  const baseY = h - 11
  const topY = 13
  const amp = baseY - topY
  const right = w - padR + 6

  ctx.font = MONO
  ctx.textBaseline = 'alphabetic'

  // Nothing to plot, and two different reasons for it — said in words, because
  // an empty chart and a chart of zeroes look identical and mean opposite things.
  if (mode === 'scan' || mode === 'none') {
    ctx.strokeStyle = 'rgba(91,88,82,.35)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(padL, baseY + .5); ctx.lineTo(right, baseY + .5); ctx.stroke()

    if (mode === 'scan') {
      const span = right - padL
      const ww = span * 0.26
      const x = padL + (span + ww) * o.scanPhase - ww
      const g0 = ctx.createLinearGradient(x, 0, x + ww, 0)
      g0.addColorStop(0, col + '00'); g0.addColorStop(.5, col + 'cc'); g0.addColorStop(1, col + '00')
      ctx.strokeStyle = g0
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(Math.max(padL, x), baseY)
      ctx.lineTo(Math.min(right, x + ww), baseY)
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(128,125,116,.95)'
    ctx.fillText(mode === 'scan' ? 'no heartbeat yet' : 'round-trips not reported', padL, topY + 3)
    return
  }

  // the ceiling of the scale, stated
  ctx.strokeStyle = 'rgba(128,125,116,.5)'
  ctx.lineWidth = 1
  ctx.setLineDash([1.5, 4])
  ctx.beginPath(); ctx.moveTo(padL, topY + .5); ctx.lineTo(right, topY + .5); ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(128,125,116,.95)'
  ctx.fillText('400ms', padL, topY - 4)

  // the window this covers: 40 pongs, one every 15 s
  ctx.fillStyle = 'rgba(128,125,116,.8)'
  ctx.fillText('10 min', padL, h - 2)
  const nowW = ctx.measureText('now').width
  ctx.fillText('now', right - nowW, h - 2)

  // zero
  ctx.strokeStyle = 'rgba(128,125,116,.28)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(padL, baseY + .5); ctx.lineTo(right, baseY + .5); ctx.stroke()

  if (mode === 'flat') {
    ctx.strokeStyle = col
    ctx.globalAlpha = .6
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(padL, baseY); ctx.lineTo(right, baseY); ctx.stroke()
    ctx.globalAlpha = 1
    return
  }

  const series = padSeries(o.series)
  const yOf = (ms: number): number => baseY - Math.min(ms, TRACE_CEILING_MS) / TRACE_CEILING_MS * amp

  // the run, as a step plot: one flat tread per heartbeat
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'miter'
  ctx.strokeStyle = col
  let prevX: number | null = null
  let prevY: number | null = null
  let firstX: number | null = null
  let started = false
  ctx.beginPath()
  for (let i = 0; i < TRACE_SAMPLES; i++) {
    const v = series[i]
    const x = padL + i * step
    if (v === null || v === undefined) { started = false; prevY = null; continue }
    const y = yOf(v)
    if (firstX === null) firstX = x
    if (!started) { ctx.moveTo(x, y); started = true }
    else if (prevY !== null) { ctx.lineTo(x, prevY); ctx.lineTo(x, y) }
    prevX = x
    prevY = y
  }
  ctx.stroke()

  if (prevY !== null && prevX !== null && firstX !== null) {
    const g = ctx.createLinearGradient(0, topY, 0, baseY)
    g.addColorStop(0, col + '2b'); g.addColorStop(1, col + '00')
    ctx.lineTo(prevX, baseY); ctx.lineTo(firstX, baseY)
    ctx.closePath()
    ctx.fillStyle = g
    ctx.fill()
  }

  // clamped samples: marked at the ceiling, never silently rescaled
  ctx.fillStyle = '#ffb547'
  for (let k = 0; k < TRACE_SAMPLES; k++) {
    const v = series[k]
    if (v !== null && v !== undefined && v > TRACE_CEILING_MS) {
      ctx.fillRect(padL + k * step - 1, topY, 2, 3)
    }
  }

  if (prevY !== null && prevX !== null) {
    const lastV = series[TRACE_SAMPLES - 1]
    ctx.fillStyle = (lastV !== null && lastV !== undefined && lastV > TRACE_CEILING_MS) ? '#ffb547' : col
    ctx.fillRect(prevX - 2, prevY - 2, 4, 4)
  }

  // where the socket actually dropped: the last run of missing samples
  if (mode === 'break') {
    let bx: number | null = null
    for (let i = TRACE_SAMPLES - 1; i >= 0; i--) {
      const v = series[i]
      if (v !== null && v !== undefined) { bx = padL + (i + 1) * step; break }
    }
    if (bx !== null && bx < right) {
      ctx.strokeStyle = 'rgba(255,181,71,.45)'
      ctx.lineWidth = 1
      ctx.setLineDash([1.5, 3.5])
      ctx.beginPath(); ctx.moveTo(bx, topY - 1); ctx.lineTo(bx, baseY + 3); ctx.stroke()
      ctx.setLineDash([])
    }
  }
}

/** Right-align a short history against the strip's fixed window: a daemon up
 *  for two minutes has eight samples, and they belong at `now`, with the eight
 *  minutes before it left empty rather than stretched to fill. */
export function padSeries(series: (number | null)[]): (number | null)[] {
  const tail = series.slice(-TRACE_SAMPLES)
  if (tail.length === TRACE_SAMPLES) return tail
  return [...new Array<number | null>(TRACE_SAMPLES - tail.length).fill(null), ...tail]
}
