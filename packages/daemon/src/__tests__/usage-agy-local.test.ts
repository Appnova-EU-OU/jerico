/**
 * Antigravity's LOCAL path: asking the running `agy` instead of Google.
 *
 * Fixture is the real `RetrieveUserQuotaSummary` response, HTTP 200 on
 * 127.0.0.1:52963, measured 2026-08-11.
 *
 * Two classes of test here, and the second is the unusual one:
 *   - the parser, against the real grouped payload
 *   - the DISCOVERY, because finding a local endpoint means running `pgrep` and
 *     `lsof` and then posting to a port, and each of those steps has a way to go
 *     wrong that reaches outside this process
 */

import { describe, expect, test } from 'bun:test'
import * as http from 'node:http'
import { __test_askAgyPort, findAgyPids, findListenPorts } from '../usage/providers/agy-local.js'
import { localWindowMinutes, parseLocalPlan, parseLocalQuotaSummary } from '../usage/providers/agy.js'

const REAL_QUOTA = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-08-18T18:57:21Z' },
          { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-08-12T00:30:07Z' },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1, resetTime: '2026-08-18T19:30:07Z' },
          { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-08-12T00:30:07Z' },
        ],
      },
    ],
  },
}

describe('parseLocalQuotaSummary', () => {
  test('a group becomes a parent and its buckets its children', () => {
    const out = parseLocalQuotaSummary(REAL_QUOTA)
    if (!('windows' in out)) throw new Error('expected windows')
    const parents = out.windows.filter((w) => w.scopedUnder === null)
    expect(parents.map((p) => p.title)).toEqual(['gemini models', 'claude and gpt models'])
    for (const p of parents) {
      expect(out.windows.filter((w) => w.scopedUnder === p.id)).toHaveLength(2)
    }
  })

  test('BOTH windows survive — this is what the OAuth path could not give', () => {
    // Google's retrieveUserQuota returns per-model buckets with one daily reset.
    // The difference between that and this is the difference between "you have
    // quota today" and "your session runs out in two hours".
    const out = parseLocalQuotaSummary(REAL_QUOTA)
    if (!('windows' in out)) throw new Error('expected windows')
    const titles = out.windows.filter((w) => w.scopedUnder !== null).map((w) => w.title)
    expect(titles.filter((t) => t === '5h')).toHaveLength(2)
    expect(titles.filter((t) => t === 'weekly')).toHaveLength(2)
  })

  test('remainingFraction 1 means nothing used', () => {
    const out = parseLocalQuotaSummary(REAL_QUOTA)
    if (!('windows' in out)) throw new Error('expected windows')
    for (const w of out.windows) expect(w.usedPercent).toBe(0)
  })

  test('a fraction is inverted and scaled, not read as a percentage', () => {
    const out = parseLocalQuotaSummary({
      response: { groups: [{ displayName: 'G', buckets: [{ bucketId: 'b', window: '5h', remainingFraction: 0.3 }] }] },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.find((w) => w.scopedUnder !== null)?.usedPercent).toBeCloseTo(70, 5)
  })

  test('the group carries its WORST bucket, never an average', () => {
    // 90 and 10 average to 50 — a number neither bucket reported, and the wrong
    // one to act on.
    const out = parseLocalQuotaSummary({
      response: {
        groups: [{
          displayName: 'G',
          buckets: [
            { bucketId: 'a', window: '5h', remainingFraction: 0.1, resetTime: '2026-08-12T00:30:07Z' },
            { bucketId: 'b', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-08-18T00:00:00Z' },
          ],
        }],
      },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    const parent = out.windows.find((w) => w.scopedUnder === null)
    expect(parent?.usedPercent).toBe(90)
    // and it inherits that bucket's reset and length, not the other's
    expect(parent?.resetsAt).toBe(Date.parse('2026-08-12T00:30:07Z'))
    expect(parent?.windowMinutes).toBe(300)
  })

  test('the title is the WINDOW, not the bucket id', () => {
    // `gemini-5h` is an implementation detail that happens to contain what a user
    // reads. `5h` is what a user reads.
    const out = parseLocalQuotaSummary(REAL_QUOTA)
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.some((w) => w.title === 'gemini-5h')).toBe(false)
    expect(out.windows.some((w) => w.title === '5h')).toBe(true)
  })

  test('a bucket with no remainingFraction is dropped', () => {
    const out = parseLocalQuotaSummary({
      response: {
        groups: [{ displayName: 'G', buckets: [{ bucketId: 'a', window: '5h' }, { bucketId: 'b', window: 'weekly', remainingFraction: 0.5 }] }],
      },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.filter((w) => w.scopedUnder !== null)).toHaveLength(1)
  })

  test('a group with no readable bucket is skipped, not drawn empty', () => {
    const out = parseLocalQuotaSummary({
      response: {
        groups: [
          { displayName: 'Empty', buckets: [] },
          { displayName: 'Real', buckets: [{ bucketId: 'a', window: '5h', remainingFraction: 0.5 }] },
        ],
      },
    })
    if (!('windows' in out)) throw new Error('expected windows')
    expect(out.windows.filter((w) => w.scopedUnder === null).map((w) => w.title)).toEqual(['real'])
  })

  test('a response with no groups is an error, not an empty success', () => {
    expect('error' in parseLocalQuotaSummary({ response: {} })).toBe(true)
    expect('error' in parseLocalQuotaSummary({})).toBe(true)
    expect('error' in parseLocalQuotaSummary(null)).toBe(true)
    expect('error' in parseLocalQuotaSummary({ response: { groups: [] } })).toBe(true)
  })
})

describe('localWindowMinutes', () => {
  test('reads the window name the payload states', () => {
    expect(localWindowMinutes('5h')).toBe(300)
    expect(localWindowMinutes('weekly')).toBe(7 * 24 * 60)
    expect(localWindowMinutes('daily')).toBe(24 * 60)
  })

  test('an unrecognised window is null, not a guess', () => {
    // Costs the pace projection; keeps the percentage and the reset.
    expect(localWindowMinutes('fortnightly')).toBeNull()
    expect(localWindowMinutes(null)).toBeNull()
    expect(localWindowMinutes(300)).toBeNull()
  })
})

describe('parseLocalPlan', () => {
  test('reads the tier the local status reports', () => {
    expect(parseLocalPlan({ userStatus: { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO' } } } })).toBe('pro')
    expect(parseLocalPlan({ userStatus: { planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_FREE_TRIAL' } } } })).toBe('free trial')
  })

  test('falls back to a plan name, then to null', () => {
    expect(parseLocalPlan({ userStatus: { planStatus: { planInfo: { planName: 'Individual' } } } })).toBe('individual')
    expect(parseLocalPlan({ userStatus: { planStatus: {} } })).toBeNull()
    expect(parseLocalPlan({})).toBeNull()
    expect(parseLocalPlan(null)).toBeNull()
  })
})

describe('findAgyPids', () => {
  test('matches the executable name EXACTLY', async () => {
    // `pgrep -x agy`, not `-f`. A substring search over full command lines finds
    // its own shell, every editor with the word on screen, and this test file.
    let seen: string[] = []
    await findAgyPids((bin, args) => {
      seen = [bin, ...args]
      return Promise.resolve('')
    })
    expect(seen).toEqual(['/usr/bin/pgrep', '-x', 'agy'])
  })

  test('reads pids and ignores anything that is not one', async () => {
    const pids = await findAgyPids(() => Promise.resolve('39149\n67133\nnot-a-pid\n\n'))
    expect(pids).toEqual([39149, 67133])
  })

  test('a machine with nothing running yields an empty list, not an error', async () => {
    expect(await findAgyPids(() => Promise.resolve(''))).toEqual([])
  })

  test('the process count is bounded', async () => {
    const many = Array.from({ length: 40 }, (_, i) => String(1000 + i)).join('\n')
    expect((await findAgyPids(() => Promise.resolve(many))).length).toBeLessThanOrEqual(4)
  })
})

describe('findListenPorts', () => {
  const LSOF_REAL = [
    'COMMAND   PID        USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'agy     39149 owner         10u     IPv4 0x98326ec33bae3443        0t0                 TCP 127.0.0.1:52962 (LISTEN)',
    'agy     39149 owner         11u     IPv4 0xc88185fb258faf67        0t0                 TCP 127.0.0.1:52963 (LISTEN)',
  ].join('\n')

  test('reads the loopback ports out of real lsof output', async () => {
    expect(await findListenPorts(39149, () => Promise.resolve(LSOF_REAL))).toEqual([52962, 52963])
  })

  test('a listener on a ROUTABLE address is not ours to poke', async () => {
    const routable = 'agy 1 me 10u IPv4 0x1 0t0 TCP 10.22.72.88:8080 (LISTEN)\nagy 1 me 11u IPv4 0x2 0t0 TCP 127.0.0.1:9999 (LISTEN)'
    expect(await findListenPorts(1, () => Promise.resolve(routable))).toEqual([9999])
  })

  test('an established connection is not a listener', async () => {
    const established = 'agy 1 me 10u IPv4 0x1 0t0 TCP 127.0.0.1:52963->127.0.0.1:1234 (ESTABLISHED)'
    expect(await findListenPorts(1, () => Promise.resolve(established))).toEqual([])
  })

  test('the pid is re-validated before it reaches a command line', async () => {
    // It came from our own parser, but the alternative is a command whose input is
    // "whatever pgrep printed".
    let called = false
    const probe = (): Promise<string> => { called = true; return Promise.resolve(LSOF_REAL) }
    expect(await findListenPorts(0, probe)).toEqual([])
    expect(await findListenPorts(-5, probe)).toEqual([])
    expect(await findListenPorts(1.5, probe)).toEqual([])
    expect(called).toBe(false)
  })

  test('duplicate ports collapse and the count is bounded', async () => {
    const dup = Array.from({ length: 20 }, (_, i) => `agy 1 me ${String(i)}u IPv4 0x1 0t0 TCP 127.0.0.1:${String(5000 + i)} (LISTEN)`).join('\n')
    expect((await findListenPorts(1, () => Promise.resolve(dup))).length).toBeLessThanOrEqual(6)
    const same = 'agy 1 me 1u IPv4 0x1 0t0 TCP 127.0.0.1:52963 (LISTEN)\nagy 1 me 2u IPv4 0x1 0t0 TCP 127.0.0.1:52963 (LISTEN)'
    expect(await findListenPorts(1, () => Promise.resolve(same))).toEqual([52963])
  })
})

test('a reachable agy port rejection is logged without request secrets', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end('{"code":"unauthenticated","message":"missing CSRF token"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no test port')
  const calls: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { calls.push(args) }
  try {
    expect(await __test_askAgyPort(address.port)).toBeNull()
  } finally {
    console.log = original
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
  expect(calls).toContainEqual([
    '[daemon] usage.agy.local_rejected',
    expect.objectContaining({ pid: null, port: address.port, status: 401, code: 'unauthenticated' }),
  ])
})

test('the expected HTTPS wrong-port 400 is not logged as an agy rejection', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end('Client sent an HTTP request to an HTTPS server') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no test port')
  const original = console.log
  const calls: unknown[][] = []
  console.log = (...args: unknown[]) => { calls.push(args) }
  try {
    expect(await __test_askAgyPort(address.port)).toBeNull()
  } finally {
    console.log = original
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
  expect(calls).toEqual([])
})

test('a non-protocol 400 remains a structured rejection and unknown codes are discarded', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(400); res.end('{"code":"secret_shaped_value"}') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no test port')
  const calls: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { calls.push(args) }
  try { expect(await __test_askAgyPort(address.port)).toBeNull() } finally {
    console.log = original
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
  expect(calls).toContainEqual(['[daemon] usage.agy.local_rejected', expect.objectContaining({ status: 400, code: null })])
})

test('a code beyond the first 512 bytes is not read into the structured log', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(`${'x'.repeat(513)}{"code":"unauthenticated"}`) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no test port')
  const calls: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { calls.push(args) }
  try { expect(await __test_askAgyPort(address.port)).toBeNull() } finally {
    console.log = original
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
  expect(calls).toContainEqual(['[daemon] usage.agy.local_rejected', expect.objectContaining({ status: 401, code: null })])
})
