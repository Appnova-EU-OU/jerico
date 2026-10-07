import { StringDecoder } from 'node:string_decoder'

export const TUI_READY_RAW_RING_BYTES = 512

const TEXT_TAIL_CHARACTERS = 512

const DECSET_2004_MARKERS = [
  Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68]),
  Buffer.from([0x9b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68]),
] as const

const DECTCEM_SHOW_CURSOR_MARKERS = [
  Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68]),
  Buffer.from([0x9b, 0x3f, 0x32, 0x35, 0x68]),
] as const

const PROVIDER_TEXT_MARKERS = {
  codex: ['›'],
  agy: ['? for shortcuts'],
  claude: ['❯'],
  opencode: [],
  qwen: [],
} as const satisfies Record<TuiReadyProvider, readonly string[]>

export type TuiReadyProvider = 'claude' | 'codex' | 'agy' | 'opencode' | 'qwen'

export type TuiReadyEvidence =
  | 'claude-composer-glyph'
  | 'claude-show-cursor'
  | 'codex-composer-glyph'
  | 'agy-shortcuts-footer'
  | 'opencode-show-cursor'
  | 'qwen-composer-placeholder'

export interface TuiReadyScanContext {
  /**
   * Blockers are detected by the caller's text/gate logic. Passing one here
   * makes the blocker dominate any ready marker in the same chunk and requires
   * a new DECSET 2004 -> provider-marker conjunction before readiness can fire.
   */
  blockerDetected?: boolean
}

export interface TuiReadyScanResult {
  ready: boolean
  sawDecset2004: boolean
  evidence?: TuiReadyEvidence
  /** Marker-based providers must never become ready from output silence. */
  armQuietTimer: false
}

export interface TuiReadyScannerState {
  ready: boolean
  sawDecset2004: boolean
  retainedRawBytes: number
  retainedTextCharacters: number
}

export interface TuiReadyScanner {
  observe(chunk: Buffer, context?: TuiReadyScanContext): TuiReadyScanResult
  reset(): void
  getState(): TuiReadyScannerState
}

interface LocatedMarker {
  index: number
  length: number
}

function findValidMarker(haystack: Buffer, marker: Buffer): number {
  let offset = 0

  while (offset <= haystack.length - marker.length) {
    const index = haystack.indexOf(marker, offset)
    if (index === -1) return -1

    // U+009B encoded as UTF-8 is c2 9b. That is text containing a control
    // character, not the single raw C1 CSI byte required by the protocol.
    const isUtf8EncodedC1 = marker[0] === 0x9b && index > 0 && haystack[index - 1] === 0xc2
    if (!isUtf8EncodedC1) return index
    offset = index + 1
  }

  return -1
}

function findFirstMarker(haystack: Buffer, markers: readonly Buffer[]): LocatedMarker | undefined {
  let first: LocatedMarker | undefined

  for (const marker of markers) {
    const index = findValidMarker(haystack, marker)
    if (index !== -1 && (first === undefined || index < first.index)) {
      first = { index, length: marker.length }
    }
  }

  return first
}

function hasAnyMarker(haystack: Buffer, markers: readonly Buffer[]): boolean {
  return markers.some(marker => findValidMarker(haystack, marker) !== -1)
}

/**
 * Captured Qwen Code v0.24.4 transcript: bracketed-paste mode is enabled while
 * its spinner still says `Initializing...`. The editable composer is instead
 * identified by its placeholder. Keep this intentionally exact: a future TUI
 * rendering change must fail closed instead of delivering scheduled work into
 * startup output.
 */
function hasQwenInteractiveComposer(text: string): boolean {
  return text.includes('Type your message or @path/to/file')
}

/**
 * Pure incremental scanner for provider composer readiness. One scanner must
 * be created (or reset) for each panel instance; it owns no timers or I/O.
 *
 * Readiness always requires an ordered DECSET 2004 followed by the provider's
 * marker. Raw CSI matching accepts both ESC [ and the single-byte C1 CSI 0x9b.
 * Text matching uses StringDecoder so a UTF-8 glyph split between PTY chunks is
 * reconstructed without replacement characters.
 */
export function createTuiReadyScanner(provider: TuiReadyProvider): TuiReadyScanner {
  let rawTail = Buffer.alloc(0)
  let textTail = ''
  let sawDecset2004 = false
  let readyEvidence: TuiReadyEvidence | undefined
  let decoder = new StringDecoder('utf8')

  function setRawTail(data: Buffer): void {
    const start = Math.max(0, data.length - TUI_READY_RAW_RING_BYTES)
    rawTail = Buffer.from(data.subarray(start))
  }

  function appendText(data: Buffer): string {
    const combined = textTail + decoder.write(data)
    textTail = combined.slice(-TEXT_TAIL_CHARACTERS)
    return combined
  }

  function evidenceFrom(raw: Buffer, text: string): TuiReadyEvidence | undefined {
    if (
      (provider === 'opencode' || provider === 'claude')
      && hasAnyMarker(raw, DECTCEM_SHOW_CURSOR_MARKERS)
    ) {
      return provider === 'opencode' ? 'opencode-show-cursor' : 'claude-show-cursor'
    }

    const matchedText = PROVIDER_TEXT_MARKERS[provider].find(marker => text.includes(marker))
    if (provider === 'qwen' && hasQwenInteractiveComposer(text)) return 'qwen-composer-placeholder'
    if (matchedText === undefined) return undefined

    if (provider === 'codex') return 'codex-composer-glyph'
    if (provider === 'agy') return 'agy-shortcuts-footer'
    if (provider === 'claude') return 'claude-composer-glyph'
    return undefined
  }

  function reset(): void {
    rawTail = Buffer.alloc(0)
    textTail = ''
    sawDecset2004 = false
    readyEvidence = undefined
    decoder = new StringDecoder('utf8')
  }

  return {
    observe(chunk: Buffer, context: TuiReadyScanContext = {}): TuiReadyScanResult {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('TuiReadyScanner.observe requires a Buffer')
      }

      // The caller detects gates from its normalized text tail. Discard this
      // entire chunk on a gate so same-chunk ready bytes cannot be replayed and
      // a later recovery must produce a fresh ordered conjunction.
      if (context.blockerDetected) {
        reset()
        return { ready: false, sawDecset2004: false, armQuietTimer: false }
      }

      if (readyEvidence !== undefined) {
        return {
          ready: true,
          sawDecset2004: true,
          evidence: readyEvidence,
          armQuietTimer: false,
        }
      }

      if (!sawDecset2004) {
        const combined = rawTail.length === 0 ? chunk : Buffer.concat([rawTail, chunk])
        const decset = findFirstMarker(combined, DECSET_2004_MARKERS)

        if (decset === undefined) {
          setRawTail(combined)
          return { ready: false, sawDecset2004: false, armQuietTimer: false }
        }

        sawDecset2004 = true
        decoder = new StringDecoder('utf8')
        textTail = ''

        // Use the actual matched marker length. ESC [ CSI and C1 CSI have
        // different lengths, so a hard-coded offset would corrupt ordering.
        const postDecset = combined.subarray(decset.index + decset.length)
        const text = appendText(postDecset)
        readyEvidence = evidenceFrom(postDecset, text)
        setRawTail(postDecset)
      } else {
        const combinedRaw = rawTail.length === 0 ? chunk : Buffer.concat([rawTail, chunk])
        const text = appendText(chunk)
        readyEvidence = evidenceFrom(combinedRaw, text)
        setRawTail(combinedRaw)
      }

      return {
        ready: readyEvidence !== undefined,
        sawDecset2004,
        ...(readyEvidence === undefined ? {} : { evidence: readyEvidence }),
        armQuietTimer: false,
      }
    },

    reset,

    getState(): TuiReadyScannerState {
      return {
        ready: readyEvidence !== undefined,
        sawDecset2004,
        retainedRawBytes: rawTail.length,
        retainedTextCharacters: textTail.length,
      }
    },
  }
}
