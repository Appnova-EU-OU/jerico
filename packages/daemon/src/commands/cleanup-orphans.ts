import { endpointRepairCommand, getServerHttpOrigin, loadConfig } from '../config.js'

export async function runCleanupOrphans(): Promise<void> {
  const config = loadConfig()
  // #571 B1: this command sends the daemon token to whatever origin the
  // configured endpoint implies. A refused endpoint has no origin, so there is
  // nowhere to send it and nothing to do.
  const serverUrl = getServerHttpOrigin(config)
  if (serverUrl === null) {
    console.error(
      `[cli] cleanup-orphans: refusing — ${config.endpointRejection?.reason ?? 'no usable server endpoint is configured'}.`,
    )
    console.error(`[cli] Fix it with: ${endpointRepairCommand()}`)
    process.exit(1)
  }

  const res = await fetch(`${serverUrl}/api/admin/cleanup-orphans`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })

  if (!res.ok) {
    console.error(`[cli] cleanup-orphans: HTTP ${res.status}`)
    process.exit(1)
  }

  const { deleted } = await res.json() as { deleted: number }
  console.log(`[cli] cleanup-orphans: deleted ${deleted} orphaned path ${deleted === 1 ? 'entry' : 'entries'}`)
  process.exit(0)
}
