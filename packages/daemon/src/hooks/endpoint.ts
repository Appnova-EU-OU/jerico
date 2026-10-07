import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync, readFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { getHookEndpointPath } from '../profile.js'

import { HOOK_PROTOCOL, HOOK_PROTOCOL_VERSION, EVENTS_PROTOCOL_VERSION, DESCRIPTOR_FIELD_URL, DESCRIPTOR_FIELD_TOKEN } from './protocol.js'

export { HOOK_PROTOCOL, HOOK_PROTOCOL_VERSION }

export interface HookEndpointDescriptor {
  protocol: string
  /**
   * Events compatibility discriminator. The legacy field name is retained so
   * an old events CLI sees generation 2 and fails before issuing HTTP.
   * Provider hook senders read only url + hookToken from this descriptor.
   */
  protocolVersion: typeof EVENTS_PROTOCOL_VERSION
  [DESCRIPTOR_FIELD_URL]: string
  profile: string | null
  daemonPid: number
  [DESCRIPTOR_FIELD_TOKEN]: string
  writtenAt: number
}

export function generateHookToken(): string {
  return randomBytes(32).toString('hex')
}

export function writeHookEndpointDescriptor(descriptor: HookEndpointDescriptor): void {
  const dest = getHookEndpointPath()
  const dir = path.dirname(dest)
  mkdirSync(dir, { recursive: true })
  
  const tempPath = path.join(dir, `.agent-hook-endpoint.json.tmp.${process.pid}.${randomBytes(4).toString('hex')}`)
  writeFileSync(tempPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })
  chmodSync(tempPath, 0o600)
  renameSync(tempPath, dest)
}

export function removeHookEndpointDescriptorIfOwned(daemonPid: number, hookToken: string): void {
  const dest = getHookEndpointPath()
  try {
    const raw = readFileSync(dest, 'utf-8')
    const parsed = JSON.parse(raw) as HookEndpointDescriptor
    if (parsed.daemonPid === daemonPid && parsed.hookToken === hookToken) {
      unlinkSync(dest)
    }
  } catch {
    // If it doesn't exist or isn't parseable, there's nothing to remove.
  }
}
