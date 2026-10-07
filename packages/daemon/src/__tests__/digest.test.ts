/**
 * Unit tests for the repo digest (issue #512 P3): fallback walk ignore rules,
 * hard byte budget with whole-line head+tail elision, and git status flags.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildRepoDigest, clearRepoDigestCache } from '../fs/digest.js'

let tmpRoot = ''

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-test-'))
  return fs.realpathSync(dir)
}

beforeEach(() => {
  clearRepoDigestCache()
  tmpRoot = mkTmp()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function write(rel: string, size = 32): void {
  const full = path.join(tmpRoot, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, 'x'.repeat(size))
}

describe('repo digest — walk fallback (non-git)', () => {
  test('lists files with sizes, ignores node_modules/.git/dist and dotfiles', () => {
    write('src/index.ts')
    write('node_modules/pkg/index.js')
    write('.git/config')
    write('dist/bundle.js')
    write('.hidden/secret.txt')
    const digest = buildRepoDigest(tmpRoot)
    expect(digest).toContain('index.ts')
    expect(digest).not.toContain('node_modules')
    expect(digest).not.toContain('bundle.js')
    expect(digest).not.toContain('secret.txt')
    expect(digest).toContain('walk fallback')
  })

  test('hard budget: head+tail elision, whole lines only, marker present', () => {
    for (let i = 0; i < 300; i++) write(`pkg/mod${String(i).padStart(3, '0')}/file.ts`, 512)
    const digest = buildRepoDigest(tmpRoot)
    expect(digest.length).toBeLessThanOrEqual(2560)
    expect(digest).toContain('[… ')
    expect(digest).toContain('elided …]')
    // Every line must be complete: no line ends mid-path (all file lines carry
    // a size suffix or are structural lines).
    for (const line of digest.split('\n')) {
      const structural = line.startsWith('root:') || line.startsWith('[…')
      expect(structural || /\(\d+(\.\d+)?[BKM]\)$/.test(line)).toBe(true)
    }
  })

  test('empty directory → empty digest', () => {
    expect(buildRepoDigest(tmpRoot)).toBe('')
  })
})

describe('repo digest — git path', () => {
  function git(...args: string[]): void {
    const res = spawnSync('git', ['-C', tmpRoot, ...args], { encoding: 'utf-8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  }

  test('uses git ls-files, respects .gitignore, flags modified/untracked', () => {
    git('init', '-q')
    git('config', 'user.email', 'test@test')
    git('config', 'user.name', 'test')
    write('src/tracked.ts')
    write('src/ignored.log')
    fs.writeFileSync(path.join(tmpRoot, '.gitignore'), '*.log\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    // Modify tracked + add untracked-not-ignored
    write('src/tracked.ts', 128)
    write('src/new.ts')
    const digest = buildRepoDigest(tmpRoot)
    expect(digest).toContain('git ls-files')
    expect(digest).not.toContain('ignored.log')
    expect(digest).toMatch(/tracked\.ts \(\d+B\) \[M\]/)
    expect(digest).toMatch(/new\.ts \(\d+B\) \[\?\]/)
  })
})
