import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  parseLsofOutput,
  probeListener,
  sanitizeDevServerTitle,
  scanDevServers,
  type ListenerCandidate,
} from '../preview/dev-server-discovery.js'

const openServers: http.Server[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(handler: http.RequestListener, host: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return { server, port: (server.address() as AddressInfo).port }
}

describe('dev-server lsof parsing', () => {
  test('keeps loopback families, expands wildcards, and rejects LAN listeners', () => {
    const fixture = [
      'p100', 'cnode', 'f10', 'tIPv4', 'n127.0.0.1:5173',
      'f11', 'tIPv6', 'n[::1]:5173',
      'f12', 'tIPv4', 'n*:3000',
      'f13', 'tIPv4', 'n192.168.1.10:8080',
      'f14', 'tIPv4', 'n127.0.0.1:not-a-port',
      'f15', 'tIPv4', 'n127.0.0.1:5173',
    ].join('\0')

    expect(parseLsofOutput(fixture, () => false)).toEqual({
      candidates: [
        { port: 3000, family: 4 },
        { port: 5173, family: 4 },
        { port: 5173, family: 6 },
      ],
      truncated: false,
    })
  })

  test('excludes active preview-proxy ports and caps candidate fan-out', () => {
    const fields: string[] = []
    for (let port = 10_000; port < 10_080; port++) {
      fields.push(`f${port}`, 'tIPv4', `n127.0.0.1:${port}`)
    }
    const result = parseLsofOutput(fields.join('\0'), port => port === 10_000)
    expect(result.candidates).toHaveLength(64)
    expect(result.candidates.some(candidate => candidate.port === 10_000)).toBe(false)
    expect(result.truncated).toBe(true)
  })
})

describe('dev-server title privacy', () => {
  test('decodes safe titles and removes controls', () => {
    expect(sanitizeDevServerTitle('  My &amp; Your\u0000 App  ')).toBe('My & Your App')
  })

  test('redacts secret-like, high-entropy, and missing titles', () => {
    expect(sanitizeDevServerTitle('Bearer token dashboard')).toBe('Local web server')
    expect(sanitizeDevServerTitle('a9X_2kLmN7pQrS8tUvW3yZ4bCdEfGh')).toBe('Local web server')
    expect(sanitizeDevServerTitle('')).toBe('Local web server')
  })
})

describe('dev-server HTTP probing', () => {
  test('accepts bounded HTML and returns origin-only with a sanitized title', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>Vite &amp; Friends</title><h1>ok</h1>')
    }, '127.0.0.1')
    const result = await probeListener({ port, family: 4 }, Date.now() + 2_000, new AbortController().signal)
    expect(result).toEqual({ title: 'Vite & Friends', address: `http://127.0.0.1:${port}` })
  })

  test('rejects JSON HTTP services', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }, '127.0.0.1')
    const result = await probeListener({ port, family: 4 }, Date.now() + 2_000, new AbortController().signal)
    expect(result).toBeNull()
  })

  test('bounds a listener that accepts TCP but never replies', async () => {
    const sockets = new Set<import('node:net').Socket>()
    const raw = (await import('node:net')).createServer(socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    openServers.push(raw as unknown as http.Server)
    await new Promise<void>((resolve, reject) => {
      raw.once('error', reject)
      raw.listen(0, '127.0.0.1', resolve)
    })
    const port = (raw.address() as AddressInfo).port
    const started = Date.now()
    const result = await probeListener({ port, family: 4 }, Date.now() + 1_000, new AbortController().signal)
    for (const socket of sockets) socket.destroy()
    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(900)
  })

  test('preserves IPv6 when it is the reachable family', async () => {
    let listener: { server: http.Server; port: number }
    try {
      listener = await listen((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><title>IPv6 app</title></html>')
      }, '::1')
    } catch {
      return // Host has no IPv6 loopback support.
    }
    const result = await probeListener({ port: listener.port, family: 6 }, Date.now() + 2_000, new AbortController().signal)
    expect(result).toEqual({ title: 'IPv6 app', address: `http://[::1]:${listener.port}` })
  })
})

describe('dev-server scan orchestration', () => {
  test('returns explicit unsupported_platform without enumerating', async () => {
    let enumerated = false
    const result = await scanDevServers({
      platform: 'linux',
      enumerate: async () => {
        enumerated = true
        return { candidates: [], truncated: false }
      },
    })
    expect(result.error).toBe('unsupported_platform')
    expect(enumerated).toBe(false)
  })

  test('prefers verified IPv4 for dual-stack and otherwise retains IPv6', async () => {
    const candidates: ListenerCandidate[] = [
      { port: 3000, family: 4 },
      { port: 3000, family: 6 },
      { port: 4000, family: 4 },
      { port: 4000, family: 6 },
    ]
    const result = await scanDevServers({
      platform: 'darwin',
      enumerate: async () => ({ candidates, truncated: false }),
      proxyPort: () => false,
      probe: async candidate => {
        if (candidate.port === 4000 && candidate.family === 4) return null
        const host = candidate.family === 4 ? '127.0.0.1' : '[::1]'
        return { title: `App ${candidate.port}`, address: `http://${host}:${candidate.port}` }
      },
    })
    expect(result.servers).toEqual([
      { title: 'App 3000', address: 'http://127.0.0.1:3000' },
      { title: 'App 4000', address: 'http://[::1]:4000' },
    ])
  })
})
