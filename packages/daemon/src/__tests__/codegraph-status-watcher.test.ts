import { describe, it, expect } from 'bun:test'
import { parseStatusResult } from '../codegraph/status-watcher'

// Post-hoc review (issue #71): the daemon's status forwarder re-whitelists the
// codegraph engine's response field-by-field, and unsupportedLanguages was
// dropped at parse time — so a human looking at the Jerico UI on a C#/unsupported
// project still saw "not indexed yet" forever, the exact confusion #71 was filed
// about, even though the MCP-facing tool response carried the fix correctly.
function toolResult(json: Record<string, unknown>) {
  return { content: [{ type: 'text', text: JSON.stringify(json) }] }
}

describe('parseStatusResult (issue #71 status-watcher fix)', () => {
  it('carries unsupportedLanguages through from a real engine response shape', () => {
    const parsed = parseStatusResult(toolResult({
      indexed: 0, total: 0, stale: 0, lastIndexedAt: null, indexing: false, openDbs: 1,
      resolutionCoverage: { resolved: 0, unresolved: 0 },
      unsupportedLanguages: ['csharp'],
    }))
    expect(parsed?.unsupportedLanguages).toEqual(['csharp'])
  })

  it('defaults to an empty array when the field is absent (older engine / malformed response)', () => {
    const parsed = parseStatusResult(toolResult({
      indexed: 5, total: 5, stale: 0, lastIndexedAt: 123, indexing: false, openDbs: 1,
      resolutionCoverage: { resolved: 1, unresolved: 0 },
    }))
    expect(parsed?.unsupportedLanguages).toEqual([])
  })

  it('filters out non-string entries defensively rather than crashing', () => {
    const parsed = parseStatusResult(toolResult({
      indexed: 0, total: 0, stale: 0, lastIndexedAt: null, indexing: false, openDbs: 1,
      resolutionCoverage: { resolved: 0, unresolved: 0 },
      unsupportedLanguages: ['csharp', 42, null, 'java'],
    }))
    expect(parsed?.unsupportedLanguages).toEqual(['csharp', 'java'])
  })
})
