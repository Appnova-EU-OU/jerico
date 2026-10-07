import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  checkCompletionEvidence,
  parseCompletionEvidenceRecord,
  prepareCompletionEvidence,
  releaseCompletionEvidence,
  sealCompletionEvidence,
  type PrepareCompletionEvidenceInput,
} from '../ws/completion-evidence.js'

const originalHome = process.env.HOME
const originalProfile = process.env.BRIDGE_PROFILE
let testHome = ''

function input(taskKind: 'ai' | 'shell'): PrepareCompletionEvidenceInput {
  const completionId = randomUUID()
  return {
    completionId,
    agentId: `agent-${completionId.slice(0, 8)}`,
    panelInstanceId: 41,
    expectedMarker: `JERICO_${completionId.replaceAll('-', '').toUpperCase()}_DONE`,
    taskKind,
  }
}

beforeAll(() => {
  testHome = mkdtempSync(path.join(tmpdir(), 'jerico-completion-evidence-'))
  process.env.HOME = testHome
  process.env.BRIDGE_PROFILE = 'completion-evidence-test'
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalProfile === undefined) delete process.env.BRIDGE_PROFILE
  else process.env.BRIDGE_PROFILE = originalProfile
  rmSync(testHome, { recursive: true, force: true })
})

describe('daemon-sealed completion evidence', () => {
  test('ignores worker-authored AI formatting and serializes a fixed success record', async () => {
    const binding = input('ai')
    const prepared = prepareCompletionEvidence(binding)
    expect(prepared.ok).toBe(true)
    expect(prepared.path).toBeString()

    writeFileSync(prepared.path!, `${binding.expectedMarker}\nagent=${binding.agentId}\nverdict=complete\n`)
    expect(await checkCompletionEvidence(binding, 0, async () => {})).toEqual({ verified: false, error: 'invalid_record' })

    const sealed = sealCompletionEvidence({ ...binding, outcome: 'complete' })
    expect(sealed).toEqual({
      sealed: true,
      record: { marker: binding.expectedMarker, agent: binding.agentId, verdict: 'complete' },
    })
    expect(readFileSync(prepared.path!, 'utf8')).toBe(`${binding.expectedMarker} agent=${binding.agentId} verdict=complete\n`)
    expect(await checkCompletionEvidence(binding, 0, async () => {})).toEqual({ verified: true, record: sealed.record })
    expect(releaseCompletionEvidence(binding)).toBe(true)
  })

  test('uses one receipt namespace for closed failure and rejects conflicting replay intent', () => {
    const binding = input('ai')
    const prepared = prepareCompletionEvidence(binding)
    expect(prepared.ok).toBe(true)

    const failed = sealCompletionEvidence({ ...binding, outcome: 'failed', failureCode: 'tool_error' })
    expect(failed.record?.verdict).toBe('failed:tool_error')
    expect(sealCompletionEvidence({ ...binding, outcome: 'complete' })).toEqual({
      sealed: false,
      error: 'already_sealed',
      record: failed.record,
    })
    expect(sealCompletionEvidence({ ...binding, outcome: 'failed', failureCode: 'not_open_schema' as never })).toEqual({
      sealed: false,
      error: 'invalid_request',
    })
    expect(releaseCompletionEvidence(binding)).toBe(true)
  })

  test('keeps shell exit semantics mechanical and exact', () => {
    const binding = input('shell')
    expect(parseCompletionEvidenceRecord(
      `${binding.expectedMarker} agent=${binding.agentId} verdict=complete exit_code=0`,
      binding,
    )).toEqual({ marker: binding.expectedMarker, agent: binding.agentId, verdict: 'complete', exitCode: 0 })
    expect(parseCompletionEvidenceRecord(
      `${binding.expectedMarker} agent=${binding.agentId} verdict=failed exit_code=7`,
      binding,
    )).toEqual({ marker: binding.expectedMarker, agent: binding.agentId, verdict: 'failed', exitCode: 7 })
    expect(parseCompletionEvidenceRecord(
      `${binding.expectedMarker} agent=${binding.agentId} verdict=complete exit_code=7`,
      binding,
    )).toBeNull()
    expect(parseCompletionEvidenceRecord(
      `${binding.expectedMarker} agent=${binding.agentId} verdict=failed exit_code=0`,
      binding,
    )).toBeNull()
  })
})
