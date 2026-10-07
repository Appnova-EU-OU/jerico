/**
 * The daemon endpoint contract, and the promise that the writer and the reader
 * mean the same thing by it (#571).
 *
 * `auth` has always validated the endpoint it writes. `loadConfig()` never
 * validated the one it reads, so a settings file edited by anything other than
 * `auth` could send a live bearer token, in cleartext, to a host nobody chose.
 * The contract now lives in one module and both sides call it.
 *
 * This file is named explicitly in .github/workflows/ci.yml — a daemon test
 * that is not named there never runs (#568).
 */

import { describe, expect, test } from 'bun:test'
import {
  describeEndpointRejection,
  validateDaemonEndpoint,
  type EndpointRejectionCode,
} from '@jerico/shared'
import { parseDaemonServer } from '../commands/auth.js'

/** Every value `auth` legitimately writes today, in the shape it writes it. */
const WRITER_ACCEPTS = [
  'wss://lcars.jerico.appnova.io/ws/daemon',
  'ws://localhost:3100/ws/daemon',
  'ws://127.0.0.1:3100/ws/daemon',
  'ws://[::1]:3100/ws/daemon',
  'wss://203.0.113.10/ws/daemon',
  'wss://example.internal:8443/ws/daemon',
]

function rejectionCode(raw: unknown): EndpointRejectionCode | 'accepted' {
  const result = validateDaemonEndpoint(raw)
  return result.ok ? 'accepted' : result.code
}

describe('daemon endpoint contract', () => {
  test('the production value auth writes is accepted', () => {
    // The brick test in one line: if this ever fails, every installed daemon
    // stops connecting after an upgrade.
    const result = validateDaemonEndpoint('wss://lcars.jerico.appnova.io/ws/daemon')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.url).toBe('wss://lcars.jerico.appnova.io/ws/daemon')
  })

  test('wss to an arbitrary host still passes, on purpose', () => {
    // This fix does NOT claim to stop a local process pointing the daemon at a
    // host of its choosing. #572 measured that the token is readable and
    // overwritable from a plain shell with no prompt: a process running as the
    // user is inside the trust boundary, so an encrypted endpoint it chose is
    // not something this contract can or should refuse. What this contract
    // prevents is a SILENT, REPEATING, CLEARTEXT delivery to an unintended host.
    expect(rejectionCode('wss://attacker.example.com/ws/daemon')).toBe('accepted')
  })

  test('loopback plaintext is accepted — that is the dev case', () => {
    expect(rejectionCode('ws://127.0.0.1:3100/ws/daemon')).toBe('accepted')
    expect(rejectionCode('ws://localhost:3100/ws/daemon')).toBe('accepted')
    expect(rejectionCode('ws://[::1]:3100/ws/daemon')).toBe('accepted')
  })

  test('plaintext to a non-loopback host is refused', () => {
    expect(rejectionCode('ws://192.0.2.10:8080/ws/daemon')).toBe('plaintext_remote')
    expect(rejectionCode('ws://legacy.selfhost.test/ws/daemon')).toBe('plaintext_remote')
  })

  test('a host that merely CONTAINS a loopback name is not loopback', () => {
    // Every other negative row here has no loopback substring in it, so the
    // whole table answered identically whether isLoopbackHost compared with
    // `===` or with `.includes()` — a mutation run proved it (16/16 still
    // passed under the widened arm, while these two values were accepted).
    // These are the rows that tell the two apart.
    expect(rejectionCode('ws://localhost.attacker.example/ws/daemon')).toBe('plaintext_remote')
    expect(rejectionCode('ws://127.0.0.1.attacker.example/ws/daemon')).toBe('plaintext_remote')
    expect(rejectionCode('ws://notlocalhost/ws/daemon')).toBe('plaintext_remote')
    expect(rejectionCode('ws://localhost.evil.test:3100/ws/daemon')).toBe('plaintext_remote')
    // And the genuine article is still accepted, so the fix cannot be "refuse
    // everything that looks vaguely local".
    expect(rejectionCode('ws://localhost:3100/ws/daemon')).toBe('accepted')
    expect(rejectionCode('ws://127.0.0.1:3100/ws/daemon')).toBe('accepted')
  })

  test('each contract break has its own distinguishable reason', () => {
    expect(rejectionCode('wss://user:pw@host.example/ws/daemon')).toBe('credentials')
    expect(rejectionCode('wss://host.example/ws/daemon?token=1')).toBe('query')
    expect(rejectionCode('wss://host.example/ws/daemon#frag')).toBe('fragment')
    expect(rejectionCode('wss://host.example/socket')).toBe('path')
    expect(rejectionCode('wss://host.example/ws/daemon/')).toBe('path')
    expect(rejectionCode('https://host.example/ws/daemon')).toBe('scheme')
    expect(rejectionCode('not a URL at all')).toBe('unparseable')
    expect(rejectionCode('')).toBe('empty')
    expect(rejectionCode('   ')).toBe('empty')
    expect(rejectionCode(undefined)).toBe('empty')
    expect(rejectionCode(42)).toBe('empty')
  })

  test('every rejection carries a sentence naming the cause', () => {
    const codes = new Set<string>()
    for (const raw of [
      'wss://user:pw@host.example/ws/daemon',
      'wss://host.example/ws/daemon?token=1',
      'wss://host.example/ws/daemon#frag',
      'wss://host.example/socket',
      'https://host.example/ws/daemon',
      'ws://192.0.2.10:8080/ws/daemon',
      'not a URL at all',
      '',
    ]) {
      const result = validateDaemonEndpoint(raw)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.reason.length).toBeGreaterThan(10)
      // Distinguishable: no two of these read the same.
      expect(codes.has(result.reason)).toBe(false)
      codes.add(result.reason)
    }
    expect(codes.size).toBe(8)
  })

  test('a rejection sentence never repeats embedded credentials', () => {
    const result = validateDaemonEndpoint('wss://user:hunter2@host.example/ws/daemon')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).not.toContain('hunter2')
    expect(describeEndpointRejection(result)).not.toContain('hunter2')
    expect(result.serverRedacted).not.toContain('hunter2')
    expect(result.serverRedacted).toContain('host.example')
  })
})

describe('writer / reader parity', () => {
  test('everything the writer accepts, the reader accepts', () => {
    for (const raw of WRITER_ACCEPTS) {
      const written = parseDaemonServer(raw)
      const read = validateDaemonEndpoint(written)
      expect({ raw, ok: read.ok }).toEqual({ raw, ok: true })
    }
  })

  test('everything the reader refuses, the writer refuses too', () => {
    for (const raw of [
      'wss://user:pw@host.example/ws/daemon',
      'wss://host.example/ws/daemon?token=1',
      'wss://host.example/ws/daemon#frag',
      'wss://host.example/socket',
      'https://host.example/ws/daemon',
      'ws://192.0.2.10:8080/ws/daemon',
      'not a URL at all',
      '',
    ]) {
      expect(validateDaemonEndpoint(raw).ok).toBe(false)
      expect(() => parseDaemonServer(raw)).toThrow()
    }
  })

  test('the writer normalizes to a value that is stable under re-validation', () => {
    for (const raw of WRITER_ACCEPTS) {
      const once = parseDaemonServer(raw)
      const twice = parseDaemonServer(once)
      expect(twice).toBe(once)
      const read = validateDaemonEndpoint(once)
      expect(read.ok).toBe(true)
      if (read.ok) expect(read.url).toBe(once)
    }
  })
})
