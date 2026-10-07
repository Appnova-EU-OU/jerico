import { describe, expect, test } from 'bun:test'
import {
  inspectClaudeSettings,
  receiverAcceptedForAgent,
} from './launchd-hook-proof.mts'

const managed = "/bin/sh '/tmp/fixture/jerico-hook.sh' --managed-by=jerico.tier1 --v=1 >/dev/null 2>&1 || :"

function settings(commands: string[]): string {
  return JSON.stringify({
    hooks: {
      Stop: commands.map(command => ({
        matcher: '',
        hooks: [{ type: 'command', command }],
      })),
    },
  })
}

describe('launchd hook proof harness classifiers', () => {
  test('distinguishes never installed from one managed command', () => {
    expect(inspectClaudeSettings(settings(['/bin/echo foreign']))).toEqual({
      installed: false,
      reason: 'missing_managed_command',
    })
    expect(inspectClaudeSettings(settings([managed]))).toEqual({
      installed: true,
      command: managed,
      reason: 'one_managed_command',
    })
  })

  test('does not call malformed or duplicate settings executable', () => {
    expect(inspectClaudeSettings('{')).toEqual({ installed: false, reason: 'invalid_settings' })
    expect(inspectClaudeSettings(settings([managed, managed]))).toEqual({
      installed: true,
      reason: 'duplicate_managed_commands',
    })
  })

  test('server evidence is scoped to an accepted record after the captured log offset', () => {
    const id = 'mcp-claude-00000000-1111-2222-3333-abcdef123456'
    expect(receiverAcceptedForAgent('[daemon] hook.receiver.rejected { reason: "invalid_token" }', id)).toBe(false)
    expect(receiverAcceptedForAgent(`noise\n[daemon] hook.turn_ended.accepted {\n  agentId: "ef123456",\n  eventId: "abc"\n}\n`, id)).toBe(true)
    expect(receiverAcceptedForAgent(`noise\n[daemon] hook.turn_ended.accepted {\n  agentId: "00000000",\n}\n`, id)).toBe(false)
    expect(receiverAcceptedForAgent(`\u001b[32m[daemon] hook.turn_ended.accepted\u001b[39m { agentId: \u001b[32m'ef123456'\u001b[39m }`, id)).toBe(true)
  })
})
