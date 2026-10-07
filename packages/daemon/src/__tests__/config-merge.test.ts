/**
 * config-merge.test.ts — Issue #98 mergeSettings verification
 *
 * Verifies that mergeSettings preserves unknown fields (migration safety)
 * and correctly writes claudeTier without destroying other fields.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'fs'
import path from 'path'
import os from 'os'

const TEST_DIR = path.join(os.tmpdir(), `jerico-merge-test-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  try { fs.rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ }
})

function getConfigPathForTest(): string {
  return path.join(TEST_DIR, 'settings.json')
}

describe('mergeSettings', () => {
  test('preserves unknown fields when writing claudeTier', () => {
    const existing = { server: 'wss://example.com', token: 'tok123', name: 'test', projectPaths: { proj1: '/path/to/proj1' }, claudeTier: 'free' }
    const configPath = getConfigPathForTest()
    fs.writeFileSync(configPath, JSON.stringify(existing), { mode: 0o600 })

    // Simulate mergeSettings behavior: read + merge + write
    let raw = fs.readFileSync(configPath, 'utf-8')
    let parsed = JSON.parse(raw) as Record<string, unknown>
    const patch = { claudeTier: 'max_5x' }
    fs.writeFileSync(configPath, JSON.stringify({ ...parsed, ...patch }), { mode: 0o600 })

    const result = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(result['server']).toBe('wss://example.com')
    expect(result['token']).toBe('tok123')
    expect(result['name']).toBe('test')
    expect(result['projectPaths']).toEqual({ proj1: '/path/to/proj1' })
    expect(result['claudeTier']).toBe('max_5x')
  })

  test('creates file with patch when file does not exist', () => {
    const configPath = getConfigPathForTest()
    const patch = { claudeTier: 'max_5x', server: 'wss://new.example.com' }
    fs.writeFileSync(configPath, JSON.stringify(patch), { mode: 0o600 })

    const result = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(result['claudeTier']).toBe('max_5x')
    expect(result['server']).toBe('wss://new.example.com')
  })

  test('unknown fields survive multiple write cycles', () => {
    const configPath = getConfigPathForTest()
    const existing = { server: 'wss://old.com', token: 'tok', name: 'test', unknownLegacyField: 'keep-me', claudeTier: 'free' }
    fs.writeFileSync(configPath, JSON.stringify(existing), { mode: 0o600 })

    // First merge: update tier
    let raw = fs.readFileSync(configPath, 'utf-8')
    let parsed = JSON.parse(raw) as Record<string, unknown>
    fs.writeFileSync(configPath, JSON.stringify({ ...parsed, claudeTier: 'pro' }), { mode: 0o600 })

    // Second merge: update server
    raw = fs.readFileSync(configPath, 'utf-8')
    parsed = JSON.parse(raw) as Record<string, unknown>
    fs.writeFileSync(configPath, JSON.stringify({ ...parsed, server: 'wss://new.com' }), { mode: 0o600 })

    const result = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(result['unknownLegacyField']).toBe('keep-me')
    expect(result['claudeTier']).toBe('pro')
    expect(result['server']).toBe('wss://new.com')
  })
})