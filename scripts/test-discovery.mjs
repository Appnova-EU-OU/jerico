import path from 'node:path'

const nodeExtensions = new Set(['.cjs', '.mjs', '.js', '.cts', '.mts', '.ts'])
const bunExtensions = new Set(['.cjs', '.mjs', '.js', '.jsx', '.cts', '.mts', '.ts', '.tsx'])

export function isNodeTestFile(filePath) {
  const parsed = path.parse(filePath)
  if (!nodeExtensions.has(parsed.ext)) return false

  const name = parsed.name
  const segments = filePath.split(path.sep)
  return name === 'test'
    || name.startsWith('test-')
    || name.endsWith('-test')
    || name.endsWith('_test')
    || name.endsWith('.test')
    || segments.slice(0, -1).includes('test')
}

export function isBunTestFile(filePath) {
  const parsed = path.parse(filePath)
  if (!bunExtensions.has(parsed.ext)) return false

  const name = parsed.name
  return name.endsWith('.test')
    || name.endsWith('_test')
    || name.endsWith('.spec')
    || name.endsWith('_spec')
}
