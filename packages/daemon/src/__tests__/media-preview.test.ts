import { afterEach, describe, expect, it } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAX_DECLARED_PIXELS,
  parseImageDimensions,
  probeMediaPreview,
  validateDeclaredDimensions,
  verifyImageArtifact,
} from '../preview/media-preview.js'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-media-test-'))
  tempDirs.push(dir)
  return dir
}

function pngHeader(width: number, height: number, complete = false): Buffer {
  const buffer = Buffer.alloc(complete ? 36 : 24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  if (complete) buffer.write('IEND', buffer.length - 8, 'ascii')
  return buffer
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('media preview dimension gate', () => {
  it('parses PNG, GIF, JPEG SOF0, and WebP VP8X dimensions', () => {
    expect(parseImageDimensions(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 })

    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'ascii')
    gif.writeUInt16LE(320, 6)
    gif.writeUInt16LE(240, 8)
    expect(parseImageDimensions(gif)).toEqual({ width: 320, height: 240 })

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0x01, 0x11, 0x00])
    expect(parseImageDimensions(jpeg)).toEqual({ width: 1920, height: 1080 })

    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp[24] = 0x7f // 128 wide after +1
    webp[27] = 0x3f // 64 high after +1
    expect(parseImageDimensions(webp)).toEqual({ width: 128, height: 64 })
  })

  it('rejects a small decompression-bomb header before spawning a tool', async () => {
    const cwd = tempDir()
    fs.writeFileSync(path.join(cwd, 'bomb.png'), pngHeader(20_000, 20_000))
    let toolCalls = 0
    const result = await probeMediaPreview({ cwd, path: 'bomb.png' }, {
      platform: 'darwin',
      runTool: async () => { toolCalls++ },
    })
    expect(20_000 * 20_000).toBeGreaterThan(MAX_DECLARED_PIXELS)
    expect(result.error).toBe('dimensions_too_large')
    expect(toolCalls).toBe(0)
  })

  it('accepts dimensions at the configured boundary', () => {
    expect(validateDeclaredDimensions(pngHeader(8_000, 5_000))).toEqual({ width: 8_000, height: 5_000 })
  })
})

describe('media preview artifacts and jail', () => {
  it('requires a non-empty complete image artifact, not merely tool exit success', async () => {
    const cwd = tempDir()
    fs.writeFileSync(path.join(cwd, 'screen.png'), pngHeader(800, 600))
    const result = await probeMediaPreview({ cwd, path: 'screen.png' }, {
      platform: 'darwin',
      runTool: async () => {},
    })
    expect(result.error).toBe('thumbnail_failed')

    const truncated = path.join(cwd, 'truncated.png')
    fs.writeFileSync(truncated, pngHeader(800, 600))
    expect(verifyImageArtifact(truncated)).toBeNull()
  })

  it('hands qlmanage a private source and a unique empty output directory per probe', async () => {
    const cwd = tempDir()
    const mp4 = Buffer.alloc(32)
    mp4.writeUInt32BE(24, 0)
    mp4.write('ftyp', 4, 'ascii')
    fs.writeFileSync(path.join(cwd, 'clip.mp4'), mp4)
    const outputDirs: string[] = []
    const sourcePaths: string[] = []
    const runTool = async (_command: string, args: string[]) => {
      const outputIndex = args.indexOf('-o')
      const outputDir = args[outputIndex + 1]!
      const source = args.at(-1)!
      outputDirs.push(outputDir)
      sourcePaths.push(source)
      expect(fs.readdirSync(outputDir)).toEqual([])
      fs.writeFileSync(path.join(outputDir, 'clip.mp4.png'), pngHeader(640, 360, true))
    }
    const first = await probeMediaPreview({ cwd, path: 'clip.mp4' }, { platform: 'darwin', runTool })
    const second = await probeMediaPreview({ cwd, path: 'clip.mp4' }, { platform: 'darwin', runTool })
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    expect(outputDirs[0]).not.toBe(outputDirs[1])
    expect(sourcePaths.every(source => source !== path.join(cwd, 'clip.mp4') && source.includes('jerico-thumb-'))).toBe(true)
  })

  it('rejects lexical escapes and symlinks instead of reading outside cwd', async () => {
    const cwd = tempDir()
    const outside = tempDir()
    fs.writeFileSync(path.join(outside, 'secret.png'), pngHeader(10, 10))
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(cwd, 'linked.png'))
    expect((await probeMediaPreview({ cwd, path: '../secret.png' })).error).toBe('path_denied')
    expect((await probeMediaPreview({ cwd, path: 'linked.png' })).error).toBeDefined()
  })
})
