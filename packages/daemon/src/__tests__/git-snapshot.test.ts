import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { observeProjectGitSnapshot } from '../git-snapshot.js'

let repository = ''

function git(...args: string[]): void {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

beforeEach(() => {
  repository = realpathSync(mkdtempSync(join(tmpdir(), 'jerico-git-snapshot-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test User')
  mkdirSync(join(repository, 'src'))
  writeFileSync(join(repository, 'src/index.ts'), 'export const value = 1\n')
  git('add', '.')
  git('commit', '-q', '-m', 'initial')
})

afterEach(() => {
  rmSync(repository, { recursive: true, force: true })
})

describe('daemon-observed git provenance', () => {
  test('captures branch, HEAD, and clean/dirty state from the local checkout', () => {
    const clean = observeProjectGitSnapshot(repository)
    expect(clean).toEqual({
      branchRef: 'main',
      headSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      gitDirty: false,
    })

    writeFileSync(join(repository, 'src/index.ts'), 'export const value = 2\n')
    expect(observeProjectGitSnapshot(repository)).toEqual({
      branchRef: 'main',
      headSha: clean!.headSha,
      gitDirty: true,
    })
  })

  test('returns null outside a committed git checkout', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jerico-not-git-')))
    try {
      expect(observeProjectGitSnapshot(directory)).toBeNull()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
