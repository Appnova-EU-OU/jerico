import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { eventHeaders, loadDescriptor } from '../events/client.js'
import { authorizeEventsRequest } from '../events/route.js'
import { writeHookEndpointDescriptor } from '../hooks/endpoint.js'
import { handleAgentHookRequest } from '../hooks/receiver.js'
import { getHookEndpointPath } from '../profile.js'
import {
  DESCRIPTOR_FIELD_TOKEN,
  DESCRIPTOR_FIELD_URL,
  EVENTS_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_EVENT_TOKEN,
  HEADER_INSTANCE_ID,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_TOKEN,
  HOOK_PROTOCOL,
  HOOK_ROUTE_PATH,
} from '../hooks/protocol.js'

const HOOK_VERSION = 1
const EVENTS_VERSION = 2
const TOKEN = 'h'.repeat(64)
const EVENT_TOKEN = 'e'.repeat(64)

let hookServer: Server
let hookPort = 0

beforeAll(async () => {
  hookServer = createServer(async (req, res) => {
    const manager = {
      getLiveHookTarget: () => ({ agentId: 'panel-1', instanceId: 3, agentKey: 'claude' }),
    } as any
    const ws = {
      readyState: 1,
      send: (_data: string, callback: (error?: unknown) => void) => callback(),
    } as any
    await handleAgentHookRequest(req, res, { manager, expectedToken: TOKEN, ws })
  })

  await new Promise<void>((resolve, reject) => {
    hookServer.once('error', reject)
    hookServer.listen(0, '127.0.0.1', () => {
      const address = hookServer.address()
      if (!address || typeof address === 'string') {
        reject(new Error('hook test server did not bind a TCP port'))
        return
      }
      hookPort = address.port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => hookServer.close(() => resolve()))
})

function eventRequestHeaders(version: number): Record<string, string> {
  return {
    [HEADER_TOKEN]: TOKEN,
    [HEADER_PROTOCOL]: HOOK_PROTOCOL,
    [HEADER_PROTOCOL_VERSION]: String(version),
    [HEADER_AGENT_ID]: 'panel-1',
    [HEADER_INSTANCE_ID]: '3',
    [HEADER_EVENT_TOKEN]: EVENT_TOKEN,
  }
}

async function postHook(version: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${hookPort}${HOOK_ROUTE_PATH}`, {
    method: 'POST',
    headers: {
      [HEADER_TOKEN]: TOKEN,
      [HEADER_PROTOCOL]: HOOK_PROTOCOL,
      [HEADER_PROTOCOL_VERSION]: String(version),
      [HEADER_AGENT_ID]: 'panel-1',
      [HEADER_INSTANCE_ID]: '3',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ hook_event_name: 'Stop' }),
  })
  await response.text()
  return response.status
}

describe('#620 hook/events protocol split', () => {
  test('the events client accepts an events-versioned descriptor and rejects a hook-versioned descriptor', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jerico-620-descriptor-'))
    try {
      const descriptorPath = path.join(dir, 'agent-hook-endpoint.json')
      const descriptor = {
        protocol: HOOK_PROTOCOL,
        protocolVersion: EVENTS_VERSION,
        url: 'http://127.0.0.1:3101/v1/agent-hooks/events',
        hookToken: TOKEN,
      }
      writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 })
      chmodSync(descriptorPath, 0o600)
      expect(loadDescriptor(descriptorPath)).toMatchObject({ ok: true })

      writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, protocolVersion: HOOK_VERSION }), { mode: 0o600 })
      expect(loadDescriptor(descriptorPath)).toMatchObject({
        ok: false,
        reason: 'descriptor_protocol_mismatch',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the events client sends the events generation in its transport header', () => {
    const headers = eventHeaders(
      { url: 'http://127.0.0.1/hook', origin: 'http://127.0.0.1', token: TOKEN },
      { agentId: 'panel-1', instanceId: 3 },
      EVENT_TOKEN,
    )
    expect(headers[HEADER_PROTOCOL_VERSION]).toBe(String(EVENTS_VERSION))
  })

  test('the real descriptor writer persists the events protocol generation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jerico-620-writer-'))
    const originalHome = process.env['HOME']
    const originalProfile = process.env['BRIDGE_PROFILE']
    try {
      process.env['HOME'] = dir
      process.env['BRIDGE_PROFILE'] = 'issue-620-writer-test'
      writeHookEndpointDescriptor({
        protocol: HOOK_PROTOCOL,
        protocolVersion: EVENTS_PROTOCOL_VERSION,
        [DESCRIPTOR_FIELD_URL]: 'http://127.0.0.1:3101/v1/agent-hooks/events',
        profile: 'issue-620-writer-test',
        daemonPid: process.pid,
        [DESCRIPTOR_FIELD_TOKEN]: TOKEN,
        writtenAt: 1,
      })

      const written = JSON.parse(readFileSync(getHookEndpointPath(), 'utf8')) as Record<string, unknown>
      expect(written['protocolVersion']).toBe(EVENTS_PROTOCOL_VERSION)
    } finally {
      if (originalHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = originalHome
      if (originalProfile === undefined) delete process.env['BRIDGE_PROFILE']
      else process.env['BRIDGE_PROFILE'] = originalProfile
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the real events and provider-hook gates reject each other\'s generation', async () => {
    expect(authorizeEventsRequest(eventRequestHeaders(EVENTS_VERSION), TOKEN, () => true, () => EVENT_TOKEN))
      .toEqual({ ok: true, agentId: 'panel-1', instanceId: 3 })
    expect(authorizeEventsRequest(eventRequestHeaders(HOOK_VERSION), TOKEN, () => true, () => EVENT_TOKEN))
      .toEqual({ ok: false, status: 422, error: 'protocol_mismatch' })

    expect(await postHook(HOOK_VERSION)).toBe(202)
    expect(await postHook(EVENTS_VERSION)).toBe(422)
  })

  test('events consumers cannot reach the provider-hook version constant', () => {
    const clientSource = readFileSync(new URL('../events/client.ts', import.meta.url), 'utf8')
    const routeSource = readFileSync(new URL('../events/route.ts', import.meta.url), 'utf8')
    const startSource = readFileSync(new URL('../commands/start.ts', import.meta.url), 'utf8')
    const writerStart = startSource.indexOf('writeHookEndpointDescriptor({')
    const writerEnd = startSource.indexOf('\n    })', writerStart)
    const writerSource = startSource.slice(writerStart, writerEnd)

    expect({
      clientUsesEventsVersion: clientSource.includes('EVENTS_PROTOCOL_VERSION'),
      clientUsesHookVersion: clientSource.includes('HOOK_PROTOCOL_VERSION'),
      routeUsesEventsVersion: routeSource.includes('EVENTS_PROTOCOL_VERSION'),
      routeUsesHookVersion: routeSource.includes('HOOK_PROTOCOL_VERSION'),
      writerUsesEventsVersion: writerSource.includes('protocolVersion: EVENTS_PROTOCOL_VERSION'),
    }).toEqual({
      clientUsesEventsVersion: true,
      clientUsesHookVersion: false,
      routeUsesEventsVersion: true,
      routeUsesHookVersion: false,
      writerUsesEventsVersion: true,
    })
  })
})
