/**
 * Sanitized raw PTY fragments captured from Qwen Code v0.24.4 on 2026-09-23.
 *
 * Capture command used the daemon-shaped per-panel `--mcp-config` with the
 * Bridge stdio server; identity values were redacted before this fixture was
 * committed.  The capture proves that DECSET 2004 is emitted while the UI is
 * still rotating `Initializing...`, so DECSET is transport setup, not readiness.
 * Qwen becomes editable only when it renders the composer placeholder below.
 */
export const QWEN_V0244_INITIALIZING_TRANSCRIPT = Buffer.from(
  '\x1b[?2026l\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h'
  + '\x1b]0;Qwen - jerico\x07\x1b[?2026h'
  + '  ➜ jerico · Qwen3.8-27B\n  ⠋ Initializing...\n'
  + '\x1b[?2026l\x1b[?2026h  ⠙ Initializing...\n'
  + '\x1b[?2026l\x1b[?2026h  ⠹ Initializing...\n'
  + '\x1b[?2026l\x1b[?2026h  ⠸ Initializing...\n',
)

export const QWEN_V0244_INTERACTIVE_TRANSCRIPT = Buffer.from(
  '\x1b[?2026l\x1b[?2026h\n'
  + '────────────────────────────────────────────────────────────────────────────────\n'
  + '* \x1b[48;2;212;212;212m \x1b[49m Type your message or @path/to/file\n'
  + '────────────────────────────────────────────────────────────────────────────────\n'
  + '  ➜ jerico · git:(REDACTED) · Qwen3.8-27B\n'
  + '  YOLO mode (shift + tab to cycle) · 1 MCP offline\n'
  + '\x1b[4A\x1b[3G\x1b[?25h\x1b[?2026l',
)
