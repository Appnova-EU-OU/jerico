import type { SpawnAttemptId } from '../shared/types.js'

export type SpawnTerminalFailure =
  | { code: 'AGENT_NOT_FOUND'; message: string }
  | { code: 'CWD_MISSING_ON_DAEMON'; message: string; sessionId?: string }
  | { code: 'SPAWN_FAILED'; message: string }
  | { code: 'DUPLICATE_SIMULATOR'; message: string; existingAgentId?: string; udid?: string }

export type SpawnTerminalEnvelope = SpawnTerminalFailure & {
  type: 'error'
  agentId: string
  spawnAttemptId: SpawnAttemptId
}

interface SpawnTerminalSocket {
  readyState: number
  send(data: string): unknown
}

const clip = (value: string | undefined, max: number): string | undefined =>
  value === undefined
    ? undefined
    : value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max)

/** The only emitter for terminal failures after a modern spawn was accepted. */
export function emitSpawnTerminal(
  ws: SpawnTerminalSocket | null | undefined,
  agentId: string,
  spawnAttemptId: SpawnAttemptId,
  failure: SpawnTerminalFailure,
): SpawnTerminalEnvelope | undefined {
  if (!ws || ws.readyState !== 1) return undefined
  const envelope: SpawnTerminalEnvelope = {
    type: 'error',
    agentId,
    spawnAttemptId,
    ...failure,
    message: clip(failure.message, 512)!,
    ...('sessionId' in failure ? { sessionId: clip(failure.sessionId, 200) } : {}),
    ...('existingAgentId' in failure ? { existingAgentId: clip(failure.existingAgentId, 256) } : {}),
    ...('udid' in failure ? { udid: clip(failure.udid, 200) } : {}),
  }
  ws.send(JSON.stringify(envelope))
  return envelope
}
