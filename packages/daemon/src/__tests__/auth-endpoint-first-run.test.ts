import { describe, expect, test } from 'bun:test'
import {
  assertBuiltInAuthServer,
  authNeedsConnectPage,
  configuredDaemonServerForAuth,
  daemonServerForFreshUnnamedAuth,
} from '../commands/auth.js'

describe('auth endpoint requirements on a fresh install', () => {
  test('any provided-token flow can omit the unused connect page', () => {
    expect(authNeedsConnectPage('token')).toBe(false)
    expect(authNeedsConnectPage('')).toBe(true)
  })

  test('custom auth never falls through to the production daemon URL', () => {
    expect(() => daemonServerForFreshUnnamedAuth('http://localhost:3100')).toThrow(
      'a custom auth server requires --daemon-server on first run; it is never inferred',
    )
    expect(daemonServerForFreshUnnamedAuth('https://lcars.jerico.appnova.io')).toBe(
      'wss://lcars.jerico.appnova.io/ws/daemon',
    )
    expect(daemonServerForFreshUnnamedAuth()).toBe('wss://lcars.jerico.appnova.io/ws/daemon')
  })

  test('a built-in daemon endpoint rejects a contradicting explicit auth server', () => {
    expect(() => assertBuiltInAuthServer(
      'dev',
      'http://localhost:3100',
      'http://127.0.0.1:3100',
    )).toThrow('conflicts with built-in profile "dev" auth server')
    expect(() => assertBuiltInAuthServer(
      'dev',
      'http://localhost:3100',
      'http://localhost:3100',
    )).not.toThrow()
  })

  test('re-auth validates and cannot silently override the configured daemon endpoint', () => {
    expect(configuredDaemonServerForAuth(
      'ws://localhost:3100/ws/daemon',
      'ws://localhost:3100/ws/daemon',
    )).toEqual({ url: 'ws://localhost:3100/ws/daemon', repaired: false })
    expect(() => configuredDaemonServerForAuth(
      'ws://localhost:3100/ws/daemon',
      'ws://localhost:3101/ws/daemon',
    )).toThrow('conflicts with configured daemon server')
  })

  test('a stored daemon URL is validated before it reaches the disclosure', () => {
    expect(() => configuredDaemonServerForAuth('not a daemon URL')).toThrow(
      'configured daemon server is invalid',
    )
  })

  test('the error names the flag that can actually fix it', () => {
    // #571 review B2: three surfaces told the user to re-authenticate, and
    // plain `auth` exits 1 here without writing anything. A refusal whose
    // escape hatch does not open is worse than the fault it reports.
    expect(() => configuredDaemonServerForAuth('ws://192.0.2.10:8080/ws/daemon')).toThrow(
      '--daemon-server',
    )
  })

  test('an explicit valid endpoint REPAIRS an invalid configured one', () => {
    // There is no working endpoint to protect from being repointed when the
    // configured value is one the daemon refuses to dial.
    expect(configuredDaemonServerForAuth(
      'ws://192.0.2.10:8080/ws/daemon',
      'wss://lcars.jerico.appnova.io/ws/daemon',
    )).toEqual({ url: 'wss://lcars.jerico.appnova.io/ws/daemon', repaired: true })
    expect(configuredDaemonServerForAuth(
      'not a daemon URL',
      'ws://127.0.0.1:3100/ws/daemon',
    )).toEqual({ url: 'ws://127.0.0.1:3100/ws/daemon', repaired: true })
  })

  test('a repair is still held to the contract — an invalid replacement is refused', () => {
    expect(() => configuredDaemonServerForAuth(
      'ws://192.0.2.10:8080/ws/daemon',
      'ws://192.0.2.11:8080/ws/daemon',
    )).toThrow('loopback')
  })

  test('a valid configured endpoint is never repointed, repair path or not', () => {
    expect(() => configuredDaemonServerForAuth(
      'wss://lcars.jerico.appnova.io/ws/daemon',
      'wss://somewhere.else.example/ws/daemon',
    )).toThrow('re-auth does not change this endpoint')
  })
})
