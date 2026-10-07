import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { getCodegraphDir } from '../profile.js'

function isPkg(): boolean {
  return 'pkg' in process && typeof (process as { pkg?: unknown }).pkg !== 'undefined'
}

function resolveCodegraphEntry(): string {
  // #380 Gap 3: inside a pkg binary there is no codegraph file on disk — the bundle
  // is compiled into the snapshot and reachable only by re-entering the binary as the
  // hidden `codegraph` commander subcommand (index.ts), which require()s codegraph.cjs.
  // So spawn `<binary> codegraph`, NOT a filesystem path (a path would hit commander as
  // an unknown command). Dev keeps the real-path resolution below.
  if (isPkg()) return 'codegraph'
  const daemonEntry = fs.realpathSync(process.argv[1] ?? '')
  const daemonDir = path.dirname(daemonEntry)
  const candidates = [
    path.resolve(daemonDir, '../../codegraph/dist/index.cjs'),
    path.resolve(daemonDir, 'codegraph.cjs'),
    path.resolve(process.cwd(), 'node_modules/.bin/jerico-codegraph'),
  ]
  return candidates.find(p => fs.existsSync(p)) ?? 'jerico-codegraph'
}

// #380 Gap 5: prod + `--profile dev` daemons run on one machine; a hardcoded 3201
// makes the second codegraph child's HTTP door collide (silently skipped → the mcp
// proxy hits the wrong project's codegraph). Derive the port from the profile so the
// two daemons don't overlap. The mcp-server proxy is passed the SAME value via its
// mcp-config env (ws/client.ts), so both sides of one daemon agree.
export function codegraphPort(): string {
  if (process.env['CODEGRAPH_PORT']) return process.env['CODEGRAPH_PORT']
  const profile = process.env['BRIDGE_PROFILE'] ?? ''
  return profile ? '3202' : '3201'
}

export interface CodegraphConnection {
  client: Client
  transport: StdioClientTransport
  /** Accumulates the codegraph child's stderr (used to detect ABI/DLOPEN crashes). */
  stderrChunks: string[]
}

export async function connectCodegraph(): Promise<CodegraphConnection> {
  const stderrChunks: string[] = []
  // #380: inside a pkg binary, pkg sets process.env.PKG_EXECPATH at runtime. When that
  // marker is present in a child's env, the pkg bootstrap runs in node-compat mode — it
  // treats our first arg ('codegraph') as a module PATH for runMain (`<cwd>/codegraph`)
  // instead of dispatching the app's commander subcommand → MODULE_NOT_FOUND → the child
  // exits in ~35ms → the MCP handshake dies with "Connection closed", the supervisor burns
  // its 7 restarts and gives up, and codegraph is silently unavailable in EVERY packaged
  // build. Just deleting PKG_EXECPATH from the child env is NOT enough: pkg's own spawn
  // patch RE-INJECTS it whenever the spawn command === process.execPath. So we must not
  // spawn the binary directly — we go through a shell (command != execPath, so pkg leaves
  // it alone) that unsets the marker and exec's the binary, which then boots as the bundled
  // app. Same principle as the bridge-mcp shell wrapper. Dev/non-pkg spawns node directly.
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'PKG_EXECPATH') childEnv[k] = v
  }
  childEnv['CODEGRAPH_PORT'] = codegraphPort()
  childEnv['BRIDGE_PROFILE'] = process.env['BRIDGE_PROFILE'] ?? ''
  childEnv['CODEGRAPH_MANAGED'] = '1'
  childEnv['CODEGRAPH_ADOPTION_DIR'] = getCodegraphDir()

  const entry = resolveCodegraphEntry()
  let command: string
  let args: string[]
  if (isPkg() && process.platform !== 'win32') {
    // exec "$0" "$@"  →  exec <binary> codegraph  (with PKG_EXECPATH unset so the child
    // boots in app mode). Passing the binary as $0 and the entry as $@ keeps it quoting-safe.
    command = '/bin/sh'
    args = ['-c', 'unset PKG_EXECPATH; exec "$0" "$@"', process.execPath, entry]
  } else {
    // Dev (node): no PKG_EXECPATH leak. (win32 pkg would need a cmd-based unset — no
    // Windows packaged build ships codegraph yet; revisit when it does.)
    command = process.execPath
    args = [entry]
  }

  const transport = new StdioClientTransport({
    command,
    args,
    env: childEnv,
    stderr: 'pipe',
  })

  transport.stderr?.on('data', (d: Buffer | string) => {
    stderrChunks.push(d.toString())
  })

  const client = new Client(
    { name: 'bridge-daemon-codegraph-client', version: '0.1.0' },
    { capabilities: {} },
  )

  await client.connect(transport)
  return { client, transport, stderrChunks }
}
