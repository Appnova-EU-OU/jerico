/**
 * Checkpoint 3 (scheduled personas, §6.2a) — validation row "Single prompt
 * delivery": a scheduled spawn's argv contains exactly ONE
 * `--append-system-prompt-file` flag, because the server-side dispatcher
 * omits `role` from the server spawn message.
 *
 * The second assertion documents the PRE-EXISTING double-delivery defect this
 * checkpoint works around, not fixes (§6.2a) — a normal persona launch that
 * carries both `role` and `systemPrompt` (every persona launch does,
 * `workspaces.ts:6447-6449`) gets the prompt written twice. This is a known
 * failure recorded here, never something to silently accept as new.
 *
 * Argv assertions only: no PTY and no launchd (the prompt files land in the
 * OS temp dir). It runs alone or in the daemon suite, whose uninstall tests
 * mock `execSync`, so nothing there reaches the real `launchctl` either.
 */
import { describe, test, expect } from 'bun:test'
import { __test_effectiveSpawnArgsForPrompts } from '../ws/client.js'

function countFlag(args: string[], flag: string): number {
  return args.filter(a => a === flag).length
}

describe('scheduled dispatch role-omission workaround (§6.2a)', () => {
  test('role omitted + systemPrompt set → exactly one --append-system-prompt-file (claude)', () => {
    const args = __test_effectiveSpawnArgsForPrompts('claude', undefined, 'duty text for the schedule', 'test-agent-1')
    expect(countFlag(args, '--append-system-prompt-file')).toBe(1)
  })

  test('role omitted + systemPrompt set → exactly one --append-system-prompt (qwen)', () => {
    const args = __test_effectiveSpawnArgsForPrompts('qwen', undefined, 'duty text for the schedule', 'test-agent-2')
    expect(countFlag(args, '--append-system-prompt')).toBe(1)
  })

  test('KNOWN PRE-EXISTING DEFECT, not fixed here: role present + systemPrompt set → TWO --append-system-prompt-file (claude)', () => {
    const args = __test_effectiveSpawnArgsForPrompts('claude', 'developer', 'duty text for the schedule', 'test-agent-3')
    expect(countFlag(args, '--append-system-prompt-file')).toBe(2)
  })

  test('role omitted, no systemPrompt → no prompt flags at all', () => {
    const args = __test_effectiveSpawnArgsForPrompts('claude', undefined, undefined, 'test-agent-4')
    expect(args.length).toBe(0)
  })
})
