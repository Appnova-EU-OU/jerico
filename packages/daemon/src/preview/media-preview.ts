import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { MediaPreviewError, MediaPreviewKind } from '../shared/types.js'

export const MAX_DECLARED_PIXELS = 40_000_000
export const MAX_WIRE_BASE64_BYTES = 500 * 1024
const MAX_IMAGE_SOURCE_BYTES = 32 * 1024 * 1024
const MAX_VIDEO_SOURCE_BYTES = 128 * 1024 * 1024
const MAX_HEADER_BYTES = 512 * 1024
const TOOL_TIMEOUT_MS = 4_000
const MAX_ACTIVE_PROBES = 1
const MAX_QUEUED_PROBES = 1

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi'])
const PLAYABLE_VIDEO_MIME: Record<string, 'video/mp4' | 'video/webm'> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export interface ImageDimensions {
  width: number
  height: number
}

export interface MediaPreviewRequest {
  cwd: string
  path: string
}

export interface MediaPreviewPayload {
  resolvedPath?: string
  kind?: MediaPreviewKind
  mime?: 'image/jpeg' | 'image/png'
  data?: string
  width?: number
  height?: number
  mtime?: number
  size?: number
  playable?: boolean
  mediaMime?: 'video/mp4' | 'video/webm'
  mediaData?: string
  error?: MediaPreviewError
}

export interface MediaPreviewDependencies {
  platform?: NodeJS.Platform
  runTool?: (command: string, args: string[]) => Promise<void>
}

interface OpenedMedia {
  fd: number
  resolvedPath: string
  extension: string
  kind: MediaPreviewKind
  size: number
  mtime: number
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep)
}

function readFromFd(fd: number, length: number, position = 0): Buffer {
  const output = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = fs.readSync(fd, output, offset, length - offset, position + offset)
    if (read === 0) break
    offset += read
  }
  return offset === length ? output : output.subarray(0, offset)
}

function readFdChunk(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, 0, length, position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead))
  })
}

async function copyFdToPath(fd: number, size: number, destination: string): Promise<void> {
  const output = await fs.promises.open(destination, 'wx', 0o600)
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < size) {
      const read = await readFdChunk(fd, chunk, Math.min(chunk.length, size - position), position)
      if (read === 0) throw new Error('source_read_failed')
      let written = 0
      while (written < read) {
        const result = await output.write(chunk, written, read - written, null)
        written += result.bytesWritten
      }
      position += read
    }
    await output.sync()
  } finally {
    await output.close()
  }
}

function openMedia(cwd: string, requestedPath: string): OpenedMedia | MediaPreviewPayload {
  if (!cwd || !path.isAbsolute(cwd)) return { error: 'invalid_cwd' }
  if (!requestedPath || requestedPath.includes('\0') || requestedPath.length > 4096) return { error: 'invalid_request' }

  let root: string
  try {
    const cwdStat = fs.lstatSync(cwd)
    if (!cwdStat.isDirectory()) return { error: 'invalid_cwd' }
    root = fs.realpathSync(cwd)
  } catch {
    return { error: 'invalid_cwd' }
  }

  const target = path.resolve(root, requestedPath)
  if (!isContained(root, target)) return { error: 'path_denied' }

  const extension = path.extname(target).toLowerCase()
  const kind = IMAGE_EXTENSIONS.has(extension) ? 'image' : VIDEO_EXTENSIONS.has(extension) ? 'video' : undefined
  if (!kind) return { error: 'unsupported_type' }

  let before: fs.Stats
  let realTarget: string
  try {
    // lstat rejects symlinks before any decoder sees the path. The inode check
    // after open closes the swap window between this check and O_NOFOLLOW.
    before = fs.lstatSync(target)
    if (!before.isFile()) return { error: 'unsupported_type' }
    realTarget = fs.realpathSync(target)
    if (!isContained(root, realTarget)) return { error: 'path_denied' }
  } catch {
    return { error: 'not_found' }
  }

  let fd: number
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return { error: 'not_found' }
  }

  try {
    const after = fs.fstatSync(fd)
    if (!after.isFile()) throw new Error('unsupported_type')
    if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('path_denied')
    const maxBytes = kind === 'image' ? MAX_IMAGE_SOURCE_BYTES : MAX_VIDEO_SOURCE_BYTES
    if (after.size <= 0) throw new Error('not_found')
    if (after.size > maxBytes) throw new Error('too_large')
    return { fd, resolvedPath: realTarget, extension, kind, size: after.size, mtime: after.mtimeMs }
  } catch (error) {
    fs.closeSync(fd)
    const code = error instanceof Error ? error.message : 'not_found'
    return { error: (code === 'path_denied' || code === 'unsupported_type' || code === 'too_large' ? code : 'not_found') as MediaPreviewError }
  }
}

function isPng(buffer: Buffer): boolean {
  return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

function isJpeg(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}

function isGif(buffer: Buffer): boolean {
  const signature = buffer.subarray(0, 6).toString('ascii')
  return signature === 'GIF87a' || signature === 'GIF89a'
}

function isWebp(buffer: Buffer): boolean {
  return buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

export function parseImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (isPng(buffer)) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (isGif(buffer) && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (isJpeg(buffer)) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue }
      while (offset < buffer.length && buffer[offset] === 0xff) offset++
      const marker = buffer[offset++]
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > buffer.length) break
      const segmentLength = buffer.readUInt16BE(offset)
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break
      if ((marker === 0xc0 || marker === 0xc2) && segmentLength >= 7) {
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
      }
      offset += segmentLength
    }
    return null
  }
  if (isWebp(buffer)) {
    const chunk = buffer.subarray(12, 16).toString('ascii')
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer[24]! + (buffer[25]! << 8) + (buffer[26]! << 16)
      const height = 1 + buffer[27]! + (buffer[28]! << 8) + (buffer[29]! << 16)
      return { width, height }
    }
    if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21)
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
    }
  }
  return null
}

export function validateDeclaredDimensions(buffer: Buffer): ImageDimensions | MediaPreviewPayload {
  const dimensions = parseImageDimensions(buffer)
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return { error: 'unsupported_type' }
  if (dimensions.width > Math.floor(MAX_DECLARED_PIXELS / dimensions.height)) return { error: 'dimensions_too_large' }
  return dimensions
}

export function verifyImageArtifact(filePath: string): { buffer: Buffer; mime: 'image/jpeg' | 'image/png'; dimensions: ImageDimensions } | null {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WIRE_BASE64_BYTES) return null
  } catch {
    return null
  }
  const buffer = fs.readFileSync(filePath)
  const jpegComplete = isJpeg(buffer) && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9
  const pngComplete = isPng(buffer) && buffer.length >= 20 && buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') === 'IEND'
  if (!jpegComplete && !pngComplete) return null
  const dimensions = parseImageDimensions(buffer)
  if (!dimensions) return null
  return { buffer, mime: jpegComplete ? 'image/jpeg' : 'image/png', dimensions }
}

function defaultRunTool(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      error ? reject(error) : resolve()
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(new Error('tool_timeout'))
    }, TOOL_TIMEOUT_MS)
    child.once('error', error => finish(error))
    child.once('close', code => code === 0 ? finish() : finish(new Error(`tool_exit_${code ?? 'unknown'}`)))
  })
}

function isVideoMagic(buffer: Buffer, extension: string): boolean {
  if ((extension === '.mp4' || extension === '.mov') && buffer.length >= 12) return buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  if ((extension === '.webm' || extension === '.mkv') && buffer.length >= 4) return buffer.readUInt32BE(0) === 0x1a45dfa3
  if (extension === '.avi' && buffer.length >= 12) return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'AVI '
  return false
}

async function makeImagePreview(source: string, rootDir: string, runTool: MediaPreviewDependencies['runTool']): Promise<ReturnType<typeof verifyImageArtifact>> {
  const output = path.join(rootDir, 'preview.jpg')
  const attempts = [
    { max: 1600, quality: 78 },
    { max: 1200, quality: 70 },
    { max: 800, quality: 62 },
  ]
  for (const attempt of attempts) {
    try { fs.rmSync(output, { force: true }) } catch {}
    try {
      await runTool!('/usr/bin/sips', ['-Z', String(attempt.max), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(attempt.quality), source, '--out', output])
    } catch {
      continue
    }
    const artifact = verifyImageArtifact(output)
    if (artifact && artifact.buffer.toString('base64').length <= MAX_WIRE_BASE64_BYTES) return artifact
  }
  return null
}

async function makeVideoPoster(source: string, outputDir: string, runTool: MediaPreviewDependencies['runTool']): Promise<ReturnType<typeof verifyImageArtifact>> {
  try {
    await runTool!('/usr/bin/qlmanage', ['-t', '-s', '640', '-o', outputDir, source])
  } catch {
    return null
  }
  const entries = fs.readdirSync(outputDir, { withFileTypes: true }).filter(entry => entry.isFile())
  if (entries.length !== 1) return null
  const artifact = verifyImageArtifact(path.join(outputDir, entries[0]!.name))
  return artifact && artifact.buffer.toString('base64').length <= MAX_WIRE_BASE64_BYTES ? artifact : null
}

export async function probeMediaPreview(request: MediaPreviewRequest, dependencies: MediaPreviewDependencies = {}): Promise<MediaPreviewPayload> {
  const opened = openMedia(request.cwd, request.path)
  if (!('fd' in opened)) return opened

  const { fd, resolvedPath, extension, kind, size, mtime } = opened
  const base: MediaPreviewPayload = { resolvedPath, kind, size, mtime }
  let tempDir: string | null = null
  const runTool = dependencies.runTool ?? defaultRunTool
  const platform = dependencies.platform ?? process.platform
  const startedAt = Date.now()
  try {
    const header = readFromFd(fd, Math.min(size, MAX_HEADER_BYTES))
    if (kind === 'image') {
      const declared = validateDeclaredDimensions(header)
      if ('error' in declared) return { ...base, error: declared.error }
      if (platform !== 'darwin') {
        const source = readFromFd(fd, size)
        const data = source.toString('base64')
        if (data.length > MAX_WIRE_BASE64_BYTES) return { ...base, width: declared.width, height: declared.height, error: 'unsupported_platform' }
        const mime = isPng(header) ? 'image/png' : isJpeg(header) ? 'image/jpeg' : undefined
        if (!mime) return { ...base, error: 'unsupported_platform' }
        return { ...base, mime, data, width: declared.width, height: declared.height }
      }

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-thumb-'))
      const source = path.join(tempDir, `source${extension}`)
      await copyFdToPath(fd, size, source)
      const artifact = await makeImagePreview(source, tempDir, runTool)
      if (!artifact) return { ...base, error: 'thumbnail_failed' }
      return {
        ...base,
        mime: artifact.mime,
        data: artifact.buffer.toString('base64'),
        width: artifact.dimensions.width,
        height: artifact.dimensions.height,
      }
    }

    if (!isVideoMagic(header, extension)) return { ...base, error: 'unsupported_type' }
    const mediaMime = PLAYABLE_VIDEO_MIME[extension]
    if (!mediaMime) return { ...base, playable: false }
    if (platform !== 'darwin') return { ...base, playable: true, mediaMime, error: 'unsupported_platform' }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jerico-thumb-'))
    const source = path.join(tempDir, `source${extension}`)
    const outputDir = path.join(tempDir, 'output')
    fs.mkdirSync(outputDir, { mode: 0o700 })
    await copyFdToPath(fd, size, source)
    const poster = await makeVideoPoster(source, outputDir, runTool)
    if (!poster) return { ...base, playable: true, mediaMime, error: 'thumbnail_failed' }
    const data = poster.buffer.toString('base64')
    const remaining = MAX_WIRE_BASE64_BYTES - data.length
    const candidateMediaData = size <= Math.floor(remaining * 0.75) ? readFromFd(fd, size).toString('base64') : undefined
    const mediaData = candidateMediaData && data.length + candidateMediaData.length <= MAX_WIRE_BASE64_BYTES
      ? candidateMediaData
      : undefined
    return {
      ...base,
      mime: poster.mime,
      data,
      width: poster.dimensions.width,
      height: poster.dimensions.height,
      playable: true,
      mediaMime,
      ...(mediaData ? { mediaData } : {}),
    }
  } catch (error) {
    console.warn(JSON.stringify({ ts: Date.now(), level: 'warn', event: 'media.probe.rejected', reason: error instanceof Error ? error.message : String(error) }))
    return { ...base, error: 'thumbnail_failed' }
  } finally {
    fs.closeSync(fd)
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    console.log(JSON.stringify({ ts: Date.now(), level: 'info', event: 'media.probe', kind, bytes: size, ms: Date.now() - startedAt }))
  }
}

let activeProbes = 0
const queuedProbes: Array<() => void> = []

function runQueuedProbe(request: MediaPreviewRequest, dependencies: MediaPreviewDependencies): Promise<MediaPreviewPayload> {
  activeProbes++
  return probeMediaPreview(request, dependencies).finally(() => {
    activeProbes--
    queuedProbes.shift()?.()
  })
}

export function requestMediaPreview(request: MediaPreviewRequest, dependencies: MediaPreviewDependencies = {}): Promise<MediaPreviewPayload> {
  if (activeProbes < MAX_ACTIVE_PROBES) return runQueuedProbe(request, dependencies)
  if (queuedProbes.length >= MAX_QUEUED_PROBES) return Promise.resolve({ error: 'busy' })
  return new Promise(resolve => queuedProbes.push(() => { void runQueuedProbe(request, dependencies).then(resolve) }))
}
