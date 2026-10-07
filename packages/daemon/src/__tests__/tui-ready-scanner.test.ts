import { describe, expect, test } from 'bun:test'
import {
  createTuiReadyScanner,
  TUI_READY_RAW_RING_BYTES,
  type TuiReadyProvider,
} from '../pty/tui-ready-scanner'
import {
  QWEN_V0244_INITIALIZING_TRANSCRIPT,
  QWEN_V0244_INTERACTIVE_TRANSCRIPT,
} from '../__fixtures__/qwen-v0.24.4-ready-transcript'

const ESC_DECSET_2004 = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68])
const C1_DECSET_2004 = Buffer.from([0x9b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x68])
const ESC_SHOW_CURSOR = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x68])
const C1_SHOW_CURSOR = Buffer.from([0x9b, 0x3f, 0x32, 0x35, 0x68])

function observeParts(provider: TuiReadyProvider, parts: Buffer[]) {
  const scanner = createTuiReadyScanner(provider)
  return parts.map(part => scanner.observe(part))
}

describe('createTuiReadyScanner', () => {
  describe('raw CSI parsing', () => {
    test('reassembles ESC [ DECSET 2004 split at every byte boundary', () => {
      for (let split = 1; split < ESC_DECSET_2004.length; split += 1) {
        const scanner = createTuiReadyScanner('opencode')
        expect(scanner.observe(ESC_DECSET_2004.subarray(0, split)).sawDecset2004).toBe(false)
        expect(scanner.observe(ESC_DECSET_2004.subarray(split))).toMatchObject({
          ready: false,
          sawDecset2004: true,
        })
      }
    })

    test('reassembles ESC [ show-cursor split at every byte boundary', () => {
      for (let split = 1; split < ESC_SHOW_CURSOR.length; split += 1) {
        const scanner = createTuiReadyScanner('opencode')
        scanner.observe(ESC_DECSET_2004)
        expect(scanner.observe(ESC_SHOW_CURSOR.subarray(0, split)).ready).toBe(false)
        expect(scanner.observe(ESC_SHOW_CURSOR.subarray(split))).toMatchObject({
          ready: true,
          evidence: 'opencode-show-cursor',
        })
      }
    })

    test('accepts single-byte C1 CSI for DECSET 2004 and show-cursor', () => {
      const [handshake, ready] = observeParts('opencode', [C1_DECSET_2004, C1_SHOW_CURSOR])
      expect(handshake).toMatchObject({ ready: false, sawDecset2004: true })
      expect(ready).toMatchObject({
        ready: true,
        sawDecset2004: true,
        evidence: 'opencode-show-cursor',
      })
    })

    test('reassembles C1 CSI sequences split at every byte boundary', () => {
      for (let split = 1; split < C1_DECSET_2004.length; split += 1) {
        const scanner = createTuiReadyScanner('opencode')
        scanner.observe(C1_DECSET_2004.subarray(0, split))
        expect(scanner.observe(C1_DECSET_2004.subarray(split)).sawDecset2004).toBe(true)
      }

      for (let split = 1; split < C1_SHOW_CURSOR.length; split += 1) {
        const scanner = createTuiReadyScanner('opencode')
        scanner.observe(C1_DECSET_2004)
        scanner.observe(C1_SHOW_CURSOR.subarray(0, split))
        expect(scanner.observe(C1_SHOW_CURSOR.subarray(split)).ready).toBe(true)
      }
    })

    test('rejects malformed C1 0x9b ] sequences', () => {
      const malformedDecset = Buffer.from([0x9b, 0x5d, 0x32, 0x30, 0x30, 0x34, 0x68])
      const malformedCursor = Buffer.from([0x9b, 0x5d, 0x32, 0x35, 0x68])
      const scanner = createTuiReadyScanner('opencode')

      expect(scanner.observe(Buffer.concat([malformedDecset, malformedCursor]))).toMatchObject({
        ready: false,
        sawDecset2004: false,
      })
      expect(scanner.observe(Buffer.concat([C1_DECSET_2004, malformedCursor]))).toMatchObject({
        ready: false,
        sawDecset2004: true,
      })
    })

    test('rejects UTF-8-encoded U+009B as a raw C1 CSI introducer', () => {
      const scanner = createTuiReadyScanner('opencode')
      const utf8Decset = Buffer.from('\u009b?2004h')
      const utf8Cursor = Buffer.from('\u009b?25h')

      expect(utf8Decset.toString('hex').startsWith('c29b')).toBe(true)
      expect(scanner.observe(Buffer.concat([utf8Decset, utf8Cursor]))).toEqual({
        ready: false,
        sawDecset2004: false,
        armQuietTimer: false,
      })
    })
  })

  describe('streaming UTF-8', () => {
    test('reassembles the Claude glyph split at every UTF-8 byte boundary', () => {
      const glyph = Buffer.from('❯')
      expect(glyph.length).toBe(3)

      for (let split = 1; split < glyph.length; split += 1) {
        const scanner = createTuiReadyScanner('claude')
        scanner.observe(ESC_DECSET_2004)
        expect(scanner.observe(glyph.subarray(0, split)).ready).toBe(false)
        expect(scanner.observe(glyph.subarray(split))).toMatchObject({
          ready: true,
          evidence: 'claude-composer-glyph',
        })
      }
    })

    test('reassembles Qwen v0.24.4’s interactive composer placeholder across every chunk boundary', () => {
      const prompt = Buffer.from('Type your message or @path/to/file')
      for (let split = 1; split < prompt.length; split += 1) {
        const scanner = createTuiReadyScanner('qwen')
        scanner.observe(ESC_DECSET_2004)
        expect(scanner.observe(prompt.subarray(0, split)).ready).toBe(false)
        expect(scanner.observe(prompt.subarray(split))).toMatchObject({
          ready: true,
          evidence: 'qwen-composer-placeholder',
        })
      }
    })

    test('reassembles the distinct Codex glyph split at every UTF-8 byte boundary', () => {
      const glyph = Buffer.from('›')
      expect(glyph.toString('hex')).toBe('e280ba')

      for (let split = 1; split < glyph.length; split += 1) {
        const scanner = createTuiReadyScanner('codex')
        scanner.observe(ESC_DECSET_2004)
        scanner.observe(glyph.subarray(0, split))
        expect(scanner.observe(glyph.subarray(split))).toMatchObject({
          ready: true,
          evidence: 'codex-composer-glyph',
        })
      }
    })
  })

  describe('ordered provider conjunctions', () => {
    test('OpenCode requires 2004 before DECTCEM 25h', () => {
      const scanner = createTuiReadyScanner('opencode')
      expect(scanner.observe(ESC_SHOW_CURSOR).ready).toBe(false)
      expect(scanner.observe(ESC_DECSET_2004).ready).toBe(false)
      expect(scanner.observe(ESC_SHOW_CURSOR)).toMatchObject({
        ready: true,
        evidence: 'opencode-show-cursor',
      })
    })

    test('Codex requires 2004 before the › composer glyph', () => {
      const scanner = createTuiReadyScanner('codex')
      expect(scanner.observe(Buffer.from('›')).ready).toBe(false)
      expect(scanner.observe(ESC_DECSET_2004).ready).toBe(false)
      expect(scanner.observe(Buffer.from('›'))).toMatchObject({
        ready: true,
        evidence: 'codex-composer-glyph',
      })
    })

    test('agy requires 2004 before its best-effort shortcuts footer', () => {
      const scanner = createTuiReadyScanner('agy')
      expect(scanner.observe(Buffer.from('? for shortcuts')).ready).toBe(false)
      expect(scanner.observe(ESC_DECSET_2004).ready).toBe(false)
      expect(scanner.observe(Buffer.from('? for shortcuts'))).toMatchObject({
        ready: true,
        evidence: 'agy-shortcuts-footer',
      })
    })

    test('Qwen v0.24.4 does not release while its captured Initializing spinner rotates', () => {
      const scanner = createTuiReadyScanner('qwen')
      expect(scanner.observe(Buffer.from('✦ Qwen Code is starting…')).ready).toBe(false)
      expect(scanner.observe(QWEN_V0244_INITIALIZING_TRANSCRIPT)).toMatchObject({
        ready: false,
        sawDecset2004: true,
      })
      expect(scanner.observe(QWEN_V0244_INTERACTIVE_TRANSCRIPT)).toMatchObject({
        ready: true,
        evidence: 'qwen-composer-placeholder',
      })
    })

    test('Claude accepts either ❯ or 25h after 2004', () => {
      const glyphScanner = createTuiReadyScanner('claude')
      expect(glyphScanner.observe(Buffer.concat([ESC_DECSET_2004, Buffer.from('❯')]))).toMatchObject({
        ready: true,
        evidence: 'claude-composer-glyph',
      })

      const cursorScanner = createTuiReadyScanner('claude')
      expect(cursorScanner.observe(Buffer.concat([ESC_DECSET_2004, ESC_SHOW_CURSOR]))).toMatchObject({
        ready: true,
        evidence: 'claude-show-cursor',
      })
    })

    test('does not let a provider marker before 2004 satisfy ordering in one chunk', () => {
      const scanner = createTuiReadyScanner('agy')
      expect(
        scanner.observe(Buffer.concat([Buffer.from('? for shortcuts'), ESC_DECSET_2004])),
      ).toMatchObject({ ready: false, sawDecset2004: true })
      expect(scanner.observe(Buffer.from('? for shortcuts')).ready).toBe(true)
    })

    test('DECSET 2004 alone never readies any provider or arms quiet fallback', () => {
      for (const provider of ['claude', 'codex', 'agy', 'opencode', 'qwen'] as const) {
        expect(createTuiReadyScanner(provider).observe(ESC_DECSET_2004)).toEqual({
          ready: false,
          sawDecset2004: true,
          armQuietTimer: false,
        })
      }
    })

    test('bare 25h never readies OpenCode or Claude', () => {
      for (const provider of ['opencode', 'claude'] as const) {
        expect(createTuiReadyScanner(provider).observe(ESC_SHOW_CURSOR)).toEqual({
          ready: false,
          sawDecset2004: false,
          armQuietTimer: false,
        })
      }
    })

    test('does not promote Codex decorative fallback copy to primary proof', () => {
      const scanner = createTuiReadyScanner('codex')
      expect(
        scanner.observe(Buffer.concat([ESC_DECSET_2004, Buffer.from('/model to change')])),
      ).toMatchObject({ ready: false, sawDecset2004: true })
    })
  })

  describe('blocker, reset, and memory invariants', () => {
    test('a blocker dominates a same-chunk Claude marker and requires a fresh conjunction', () => {
      const scanner = createTuiReadyScanner('claude')
      expect(
        scanner.observe(Buffer.concat([ESC_DECSET_2004, Buffer.from('❯')]), {
          blockerDetected: true,
        }),
      ).toEqual({ ready: false, sawDecset2004: false, armQuietTimer: false })
      expect(scanner.observe(Buffer.from('❯')).ready).toBe(false)
      expect(scanner.observe(Buffer.concat([ESC_DECSET_2004, Buffer.from('❯')])).ready).toBe(true)
    })

    test('reset discards handshake, marker, decoder residue, and ready state', () => {
      const scanner = createTuiReadyScanner('claude')
      scanner.observe(ESC_DECSET_2004)
      scanner.observe(Buffer.from('❯').subarray(0, 2))
      scanner.reset()

      expect(scanner.getState()).toEqual({
        ready: false,
        sawDecset2004: false,
        retainedRawBytes: 0,
        retainedTextCharacters: 0,
      })
      expect(scanner.observe(Buffer.from('❯').subarray(2)).ready).toBe(false)
      expect(scanner.observe(ESC_SHOW_CURSOR).ready).toBe(false)
    })

    test('retains at most 512 raw bytes before and after DECSET 2004', () => {
      const scanner = createTuiReadyScanner('agy')
      scanner.observe(Buffer.alloc(TUI_READY_RAW_RING_BYTES * 8, 0x78))
      expect(scanner.getState().retainedRawBytes).toBe(TUI_READY_RAW_RING_BYTES)

      scanner.observe(ESC_DECSET_2004)
      scanner.observe(Buffer.alloc(TUI_READY_RAW_RING_BYTES * 8, 0x79))
      expect(scanner.getState()).toMatchObject({
        ready: false,
        sawDecset2004: true,
        retainedRawBytes: TUI_READY_RAW_RING_BYTES,
        retainedTextCharacters: 512,
      })
    })

    test('finds a post-handshake marker in a large chunk while retaining bounded state', () => {
      const scanner = createTuiReadyScanner('agy')
      const chunk = Buffer.concat([
        ESC_DECSET_2004,
        Buffer.alloc(TUI_READY_RAW_RING_BYTES * 4, 0x78),
        Buffer.from('? for shortcuts'),
      ])

      expect(scanner.observe(chunk).ready).toBe(true)
      expect(scanner.getState().retainedRawBytes).toBe(TUI_READY_RAW_RING_BYTES)
      expect(scanner.getState().retainedTextCharacters).toBe(512)
    })

    test('rejects non-Buffer input at runtime', () => {
      const scanner = createTuiReadyScanner('codex')
      expect(() => scanner.observe('not raw bytes' as never)).toThrow('requires a Buffer')
    })
  })
})
