import https from 'https'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { endpointRepairCommand, getServerHttpOrigin, loadConfig, mergeSettings } from '../config.js'
import { computeFingerprint } from '../ws/client.js'

export async function runLinkProject(workspaceId: string, projectId: string, localPath: string): Promise<void> {
  const config = loadConfig()
  const daemonId = createHash('sha256').update(config.token).digest('hex')
  // #571 B1: the server half of this dual-write carries the daemon token. A
  // refused endpoint yields no origin, so that half cannot run — but the local
  // override below is offline-capable and still worth writing, so this is
  // reported and skipped rather than made fatal.
  const serverUrl = getServerHttpOrigin(config)

  // Validate localPath
  const absPath = path.resolve(localPath)
  if (!path.isAbsolute(absPath)) {
    console.error('[bridge] link-project: path must be absolute')
    process.exit(1)
  }
  if (!fs.existsSync(absPath)) {
    console.error('[bridge] link-project: path does not exist:', absPath)
    process.exit(1)
  }
  const stat = fs.statSync(absPath)
  if (!stat.isDirectory()) {
    console.error('[bridge] link-project: path must be a directory:', absPath)
    process.exit(1)
  }

  // 1. Local JSON write (offline-capable)
  config.projectPaths = {
    ...(config.projectPaths ?? {}),
    [projectId]: absPath,
  }
  config.projectPathSources = {
    ...(config.projectPathSources ?? {}),
    [projectId]: 'cli',
  }
  mergeSettings({ projectPaths: config.projectPaths, projectPathSources: config.projectPathSources })
  console.log('[cli] link-project.local_json_written', { projectId, path: absPath })

  if (serverUrl === null) {
    console.error(
      `[cli] link-project: not telling the server — ${config.endpointRejection?.reason ?? 'no usable server endpoint is configured'}.`,
    )
    console.error(`[cli] Fix it with: ${endpointRepairCommand()}`)
    console.log('[cli] Local override still active — path will work on this machine')
    process.exit(0) // exit 0 because the local override works, as in the HTTP-failure path below
  }

  const url = new URL(`/api/workspaces/${workspaceId}/projects/${projectId}/machine-paths`, serverUrl)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  // 2. Server POST (dual-write)
  const body = JSON.stringify({ daemonId, localPath: absPath, machineFingerprint: computeFingerprint() })

  const statusCode = await new Promise<number>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode === 200) {
            // Issue #67: the server returns `nestedProjectWarnings` alongside
            // `ok: true` when this path nests with another project's bound path
            // on the same daemon. Every caller used to collapse the response to
            // its status code and drop the body, so the warning was computed
            // and never shown. Advisory only — the link succeeded either way,
            // so this prints and still exits 0.
            try {
              const json = JSON.parse(data) as {
                nestedProjectWarnings?: Array<{ projectName: string; localPath: string; relation: string }>
              }
              for (const w of json.nestedProjectWarnings ?? []) {
                const detail = w.relation === 'same'
                  ? `"${w.projectName}" is already bound to this exact path`
                  : w.relation === 'parent'
                    ? `this path is inside "${w.projectName}" (${w.localPath})`
                    : `"${w.projectName}" (${w.localPath}) is inside this path`
                console.warn(`[cli] link-project.nested_path_warning: ${detail}`)
              }
            } catch {
              // A 200 with an unparseable body still means the link worked.
            }
            resolve(200)
          } else {
            try {
              const json = JSON.parse(data)
              console.error('[bridge] link-project failed:', json.error ?? `HTTP ${res.statusCode}`)
            } catch {
              console.error('[bridge] link-project failed:', `HTTP ${res.statusCode}`)
            }
            resolve(res.statusCode ?? 0)
          }
        })
      },
    )
    req.on('error', (err) => { reject(err) })
    req.write(body)
    req.end()
  })

  if (statusCode === 200) {
    console.log('[cli] link-project.server_success', { projectId })
    console.log('[cli] link-project.success (dual-write)')
    console.log(`  workspace: ${workspaceId}`)
    console.log(`  project:   ${projectId}`)
    console.log(`  daemon:    ${daemonId.slice(0, 16)}…`)
    console.log(`  path:      ${absPath}`)
    console.log('[cli] Next spawn for this project will use the linked path.')
    process.exit(0)
  } else {
    console.warn('[cli] link-project.server_fail', { projectId, statusCode })
    console.log('[cli] Local override still active — path will work on this machine')
    process.exit(0) // exit 0 because local override works
  }
}
