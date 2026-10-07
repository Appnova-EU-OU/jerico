/**
 * The enforcement itself (#571 review B4).
 *
 * Round 1 shipped two lines that ARE the fix — `config.endpointRejection =
 * rejection` in `loadConfig()`, and the guard that stops the socket being
 * opened — and a mutation run deleted each of them with the whole 185-test
 * daemon suite still green. A line whose comment says "the token does not
 * leave" was guarded by nothing.
 *
 * WHY THESE TESTS DO NOT CALL loadConfig()
 *
 * `loadConfig()` reads the token through `getToken()`, which on macOS goes to
 * the Keychain and, on a file-token fallback, WRITES a `_staging_` item. A unit
 * suite must not create Keychain entries on a developer's login keychain — that
 * is the failure mode that put a modal storm on this machine today. So the
 * enforcement was refactored into decisions that need no token to exercise
 * (`endpointDialRefusal`, `getServerHttpOrigin`), both of which re-judge the
 * endpoint rather than trusting a flag some earlier line was supposed to set.
 * The end-to-end proof that the socket stays shut is the live smoke, and the
 * two source-shape assertions at the bottom are what stop the guards being
 * deleted between now and then.
 *
 * Named in .github/workflows/ci.yml. A daemon test not named there never runs (#568).
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { endpointDialRefusal, getServerHttpOrigin, type BridgeConfig } from '../config.js'

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf-8')

const REJECTED = 'ws://192.0.2.10:8080/ws/daemon'   // RFC 5737, routes nowhere
const ACCEPTED = 'wss://lcars.jerico.appnova.io/ws/daemon'

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return { server: ACCEPTED, token: 'not-a-real-token', name: 'test', ...over }
}

describe('the dial decision', () => {
  test('a refused endpoint is refused even if nothing attached a rejection', () => {
    // This is the mutant: delete `config.endpointRejection = rejection` from
    // loadConfig and the guard still has to hold, because it judges the value
    // in front of it rather than a flag it hopes someone set.
    const refusal = endpointDialRefusal(config({ server: REJECTED }))
    expect(refusal?.code).toBe('plaintext_remote')
  })

  test('an attached rejection is honoured verbatim', () => {
    const refusal = endpointDialRefusal(config({
      server: '',
      endpointRejection: { code: 'query', reason: 'no query strings', serverRedacted: 'wss://h/ws/daemon' },
    }))
    expect(refusal?.code).toBe('query')
  })

  test('an emptied server is a refusal, not an accident waiting to be dialed', () => {
    expect(endpointDialRefusal(config({ server: '' }))?.code).toBe('empty')
  })

  test('the production endpoint is dialable — the brick test at this level', () => {
    expect(endpointDialRefusal(config())).toBeNull()
    expect(endpointDialRefusal(config({ server: 'ws://127.0.0.1:3100/ws/daemon' }))).toBeNull()
  })
})

describe('no caller can obtain an origin from a refused endpoint', () => {
  test('an attached rejection yields no origin', () => {
    expect(getServerHttpOrigin(config({
      server: REJECTED,
      endpointRejection: { code: 'plaintext_remote', reason: 'refused', serverRedacted: REJECTED },
    }))).toBeNull()
  })

  test('a refused value yields no origin even with no rejection attached', () => {
    expect(getServerHttpOrigin(config({ server: REJECTED }))).toBeNull()
    expect(getServerHttpOrigin(config({ server: 'wss://host.example/ws/daemon?token=1' }))).toBeNull()
  })

  test('an emptied server yields no origin', () => {
    expect(getServerHttpOrigin(config({ server: '' }))).toBeNull()
  })

  test('an accepted endpoint still yields the origin the CLI commands need', () => {
    expect(getServerHttpOrigin(config())).toBe('https://lcars.jerico.appnova.io')
    expect(getServerHttpOrigin(config({ server: 'ws://127.0.0.1:3100/ws/daemon' })))
      .toBe('http://127.0.0.1:3100')
  })
})

describe('the guards are where they have to be', () => {
  /**
   * Shape assertions, and deliberately so: the two facts below cannot be
   * observed in-process without a token, and both were deletable in round 1
   * with every test still passing. A grep that fails when the guard leaves is
   * worth more than no guard at all, and it says plainly what it is.
   */

  test('loadConfig attaches the rejection AND empties the server', () => {
    const src = read('config.ts')
    expect(src).toContain('config.endpointRejection = rejection')
    expect(src).toContain("config.server = ''")
  })

  test('the socket guard sits before the socket', () => {
    const src = read('ws/client.ts')
    const guard = src.indexOf('const dialRefusal = endpointDialRefusal(config)')
    const dial = src.indexOf('ws = new WebSocket(config.server')
    expect(guard).toBeGreaterThan(-1)
    expect(dial).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(dial)
    // …and it must return rather than exit: a non-zero exit under launchd
    // KeepAlive is a 30-second respawn loop with no UI to explain it.
    const guardBlock = src.slice(guard, dial)
    expect(guardBlock).toContain('return')
    expect(guardBlock).not.toContain('process.exit')
  })

  test('the refusal path in start.ts never exits', () => {
    const src = read('commands/start.ts')
    const start = src.indexOf('function enterEndpointRejectedMode')
    const end = src.indexOf('function runDaemonServices')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).not.toContain('process.exit')
  })

  test('the token-carrying CLI commands go through the one origin helper', () => {
    // The leak review B1 found was not in the socket path at all: two adjacent
    // commands each derived an origin with their own copy of the same regex and
    // never asked whether the endpoint was usable. If either grows its own
    // derivation again, this fails.
    for (const rel of ['commands/cleanup-orphans.ts', 'commands/link-project.ts']) {
      const src = read(rel)
      expect({ rel, derivesItsOwn: /replace\(\/\^wss\?:/.test(src) }).toEqual({ rel, derivesItsOwn: false })
      expect({ rel, usesHelper: src.includes('getServerHttpOrigin') }).toEqual({ rel, usesHelper: true })
      expect({ rel, handlesNull: src.includes('serverUrl === null') }).toEqual({ rel, handlesNull: true })
    }
  })

  test('nothing else in the daemon derives an origin from config.server by hand', () => {
    // One definition, in config.ts. Anything else is a call site that can forget
    // to ask — which is how this leak existed in three places at once.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(full) }
        else if (entry.name.endsWith('.ts') && full !== path.join(SRC, 'config.ts')) {
          if (/replace\(\/\^wss\?:/.test(fs.readFileSync(full, 'utf-8'))) offenders.push(path.relative(SRC, full))
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})
