/**
 * The read side of the endpoint contract (#571).
 *
 * `loadConfig()` read `server` straight out of settings.json and handed it to
 * the WebSocket client. These tests cover the gate that now sits in between,
 * against real files on disk — but never against the real profile: each one
 * writes its own settings.json in a temp directory and passes the path in.
 *
 * Named in .github/workflows/ci.yml. A daemon test that is not named there
 * never runs (#568).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonEndpointRejection } from '../config.js'

const made: string[] = []

function settingsWith(server: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-571-'))
  made.push(dir)
  const file = path.join(dir, 'settings.json')
  const body = server === undefined ? {} : { server, name: 'test-agent' }
  fs.writeFileSync(file, JSON.stringify(body, null, 2))
  return file
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('read-side endpoint gate', () => {
  test('the production value passes and produces no rejection', () => {
    // Brick test, at the file level: what auth writes today must keep working.
    expect(getDaemonEndpointRejection(settingsWith('wss://lcars.jerico.appnova.io/ws/daemon'))).toBeNull()
  })

  test('the dev loopback value passes', () => {
    expect(getDaemonEndpointRejection(settingsWith('ws://127.0.0.1:3100/ws/daemon'))).toBeNull()
  })

  test('plaintext to a remote host is rejected, with the cause named', () => {
    const rejection = getDaemonEndpointRejection(settingsWith('ws://192.0.2.10:8080/ws/daemon'))
    expect(rejection?.code).toBe('plaintext_remote')
    expect(rejection?.reason).toContain('loopback')
    expect(rejection?.serverRedacted).toBe('ws://192.0.2.10:8080/ws/daemon')
  })

  test('a rejection never carries the embedded credentials it rejected', () => {
    const rejection = getDaemonEndpointRejection(settingsWith('wss://u:hunter2@host.example/ws/daemon'))
    expect(rejection?.code).toBe('credentials')
    expect(JSON.stringify(rejection)).not.toContain('hunter2')
  })

  test('an unreadable or absent config is not an endpoint rejection', () => {
    // Missing config, unparseable config and a missing token are pre-existing
    // paths with their own handling. Claiming them as endpoint rejections would
    // put a wrong reason on the tray.
    expect(getDaemonEndpointRejection(path.join(os.tmpdir(), 'jerico-571-absent', 'settings.json'))).toBeNull()

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-571-'))
    made.push(dir)
    const broken = path.join(dir, 'settings.json')
    fs.writeFileSync(broken, '{ not json')
    expect(getDaemonEndpointRejection(broken)).toBeNull()

    expect(getDaemonEndpointRejection(settingsWith(undefined))).toBeNull()
  })

  test('a stale URL that the migration rewrites is judged after the rewrite', () => {
    // loadConfig() migrates 23-88-110-113.sslip.io → the canonical wss endpoint.
    // Judging before the rewrite would reject a config the daemon then fixes.
    expect(getDaemonEndpointRejection(settingsWith('wss://23-88-110-113.sslip.io/ws/daemon'))).toBeNull()
    expect(getDaemonEndpointRejection(settingsWith('ws://23.88.110.113:3100/ws/daemon'))).toBeNull()
  })
})
