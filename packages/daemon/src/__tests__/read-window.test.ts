import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileWindow } from '../fs/read-window.js'

let dir: string
let bigLog: string
let smallLog: string

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'read-window-'))
  bigLog = path.join(dir, 'big.log')
  smallLog = path.join(dir, 'small.log')
  // 2000 numbered lines — comfortably over the 4 KB limit used below
  writeFileSync(bigLog, Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n') + '\n')
  writeFileSync(smallLog, 'only line\n')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readFileWindow', () => {
  test('a file under the limit comes back whole and unflagged', () => {
    const r = readFileWindow(smallLog, 4096)
    expect(r.truncated).toBe(false)
    expect(r.truncatedFrom).toBeUndefined()
    expect(r.content).toBe('only line\n')
  })

  test('from "end" returns the LAST lines — the ones that explain a live failure', () => {
    const r = readFileWindow(bigLog, 4096, 'end')
    expect(r.truncated).toBe(true)
    expect(r.truncatedFrom).toBe('end')
    expect(r.content.trimEnd().endsWith('line-1999')).toBe(true)
    // and must NOT be the beginning, which is what the old read always returned
    expect(r.content.startsWith('line-0\n')).toBe(false)
  })

  test('from "start" keeps the old behaviour', () => {
    const r = readFileWindow(bigLog, 4096, 'start')
    expect(r.truncated).toBe(true)
    expect(r.truncatedFrom).toBe('start')
    expect(r.content.startsWith('line-0\n')).toBe(true)
  })

  test('a tail never begins with half a line', () => {
    // The window lands at an arbitrary byte offset; a caller parsing records must
    // not be handed a fragment like "ne-1483".
    for (const limit of [1000, 2048, 4096, 7777]) {
      const r = readFileWindow(bigLog, limit, 'end')
      const firstLine = r.content.split('\n')[0]!
      expect(firstLine).toMatch(/^line-\d+$/)
    }
  })

  test('reports the full size so the caller knows what it did not get', () => {
    const r = readFileWindow(bigLog, 4096, 'end')
    expect(r.size).toBeGreaterThan(4096)
    expect(r.content.length).toBeLessThanOrEqual(4096)
  })
})
