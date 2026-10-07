#!/usr/bin/env node
import { Command } from 'commander'
import { runStart } from './commands/start.js'
import { runAuth } from './commands/auth.js'
import { runLinkProject } from './commands/link-project.js'
import { runCleanupOrphans } from './commands/cleanup-orphans.js'
import { runStop } from './commands/stop.js'
import { runRestart } from './commands/restart.js'
import { runLogs } from './commands/logs.js'
import { runProbeKeychain } from './commands/probe-keychain.js'
import { runHealKeychain } from './commands/heal-keychain.js'
import { runUninstall } from './commands/uninstall.js'
import { runInstallService } from './commands/install-service.js'
import { runMigrateFromNpm } from './commands/migrate-from-npm.js'
import { runUpdate } from './commands/update.js'
import { runUsage } from './commands/usage.js'
import { runHookDiag } from './commands/hook-diag.js'
import { runEvents } from './commands/events.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getDaemonVersion } from './version.js'
import { probeProtectedAccess } from './probe-protected-access.js'

const program = new Command()

program
  .name('bridge-agent')
  .description('Bridge local agent — connects your AI tools to Jerico')
  .version(getDaemonVersion())
  .option('--profile <name>', 'Config profile name (e.g. dev). Isolates config, lock, and fingerprint from the default prod profile.')
  .hook('preAction', (thisCommand) => {
    const profile = (thisCommand.opts() as { profile?: string }).profile
    if (profile) process.env.BRIDGE_PROFILE = profile
  })

program
  .command('start')
  .description('Start the bridge-agent daemon')
  .option('--health-port <port>', 'Health check HTTP port (default: 3101 prod, 3102 for --profile <name>). Overrides the per-profile default.')
  .action((opts: { healthPort?: string }) => {
    if (opts.healthPort) process.env.HEALTH_PORT = opts.healthPort
    runStart()
  })

program
  .command('auth')
  .description('Authenticate with Bridge server')
  .option('-s, --server <url>', 'Server URL (default: https://lcars.jerico.appnova.io)')
  .option('--daemon-server <url>', 'Daemon WebSocket URL for first-run settings; on re-auth it must match the configured URL')
  .option('--connect-page <url>', 'Token-generation page required without --token (never inferred from --server)')
  .option('-t, --token <token>', 'Use token non-interactively')
  .option('--no-browser', 'Without --token, print the auth URL and exit instead of prompting')
  .action((opts: { server?: string; daemonServer?: string; connectPage?: string; browser: boolean; token?: string }) => {
    void runAuth(opts.server, !opts.browser, opts.token, opts.daemonServer, opts.connectPage)
  })

program
  .command('link-project <workspace-id> <project-id> <local-path>')
  .description('Link a local directory to a project for this machine (Issue #152)')
  .action((workspaceId: string, projectId: string, localPath: string) => {
    void runLinkProject(workspaceId, projectId, localPath)
  })

program
  .command('cleanup-orphans')
  .description('Remove orphaned daemon_project_paths rows for this user')
  .action(() => {
    void runCleanupOrphans()
  })

program
  .command('status')
  .description('Show connection status')
  .action(async () => {
    try {
      const { loadConfig, endpointRepairCommand } = await import('./config.js')
      const config = loadConfig()
      console.log('[bridge] Config found')
      if (config.endpointRejection) {
        // `server` is emptied when the endpoint is refused, so printing it here
        // would report a blank where the real answer is "refused, and why".
        console.log('  Server:', `${config.endpointRejection.serverRedacted} — REFUSED: ${config.endpointRejection.reason}`)
        console.log('  Fix:   ', endpointRepairCommand())
      } else {
        console.log('  Server:', config.server)
      }
      console.log('  Name:', config.name)
    } catch {
      console.log('[bridge] Not authenticated. Run: bridge-agent auth')
    }
    // MUST exit explicitly. loadConfig() leaves a handle open, so without this
    // `status` prints everything correctly and then hangs forever: three copies
    // were found alive on this machine 21 hours after they were run. A read-only
    // command that never exits is how orphan processes accumulate unnoticed.
    process.exit(0)
  })

program
  .command('stop')
  .description('Stop the bridge-agent daemon')
  .option('--unload', 'Fully unload from launchd (bootout) so KeepAlive cannot respawn')
  .option('--purge', 'Hard-delete daemon agents from the server DB (use on app quit)')
  .action((opts: { unload?: boolean; purge?: boolean }) => {
    runStop(opts)
  })

program
  .command('restart')
  .description('Restart the bridge-agent daemon (stop + start + version verify)')
  .action(async () => {
    await runRestart()
  })

program
  .command('logs')
  .description('View unified lifecycle log (daemon + desktop)')
  .option('-f, --follow', 'Follow log output (tail -f)')
  .option('-n, --lines <N>', 'Number of lines to show (default: 100)', '100')
  .option('-c, --component <name>', 'Filter by component: daemon, desktop, or cli')
  .action((opts: { follow?: boolean; lines?: string; component?: string }) => {
    const component = opts.component as 'daemon' | 'desktop' | 'cli' | undefined
    if (component && !['daemon', 'desktop', 'cli'].includes(component)) {
      console.error('[bridge] Invalid component filter:', component, '(use: daemon, desktop, cli)')
      process.exit(1)
    }
    runLogs({
      follow: !!opts.follow,
      lines: parseInt(opts.lines ?? '100', 10) || 100,
      component,
    })
  })

program
  .command('install-service')
  .description('Install bridge-agent as a persistent login service (launchd plist with RunAtLoad+KeepAlive)')
  .action(() => {
    const result = runInstallService()
    if (!result.ok) {
      console.error(`[bridge] install-service.failed: ${result.message}`)
      process.exit(1)
    }
    process.exit(0)
  })

program
  .command('migrate-from-npm')
  .description('Transition from npm-installed bridge-agent to standalone binary. Stops old daemon and re-installs launchd service.')
  .action(() => {
    runMigrateFromNpm()
  })

program
  .command('uninstall')
  .description('Remove the daemon, its login service plist, auth token, config, logs, and wrapper')
  .option('--dry-run', 'Show what would be removed without removing anything')
  .option('--force', 'Skip confirmation prompt (for non-TTY / scripted use)')
  .option('--json', 'Emit JSON result summary to stdout')
  .action((opts: { dryRun?: boolean; force?: boolean; json?: boolean }) => {
    void runUninstall(opts)
  })

program
  .command('update')
  .description('Update bridge-agent to the latest version (or a specific channel)')
  .option('--check', 'Check for update availability (exit 0 if up-to-date or ahead, 10 if update available)')
  .option('--channel <name>', 'npm dist-tag channel (latest, beta, next, canary)')
  .option('--save-channel', 'Persist the channel to config (default: only used for this run)')
  .option('--force', 'Bypass active-panel safety block (allows update with live panels)')
  .option('--yes', 'Non-interactive mode (skip TTY prompts; still refuses if panels are active without --force)')
  .action((opts: { check?: boolean; channel?: string; saveChannel?: boolean; force?: boolean; yes?: boolean }) => {
    void runUpdate(opts)
  })

program
  .command('usage [agent]')
  .description('Report what an agent has left of its provider limits (omit agent for all supported)')
  .option('--json', 'Machine-readable output; always exits 0, faults are in the payload')
  .option('--no-interactive', 'Never raise a keychain prompt — the shape a background refresh takes')
  .action((agent: string | undefined, opts: { json?: boolean; interactive: boolean }) => {
    void runUsage(agent, { json: opts.json === true, interactive: opts.interactive })
  })

program
  .command('events')
  .description('Stream orchestration notices for this panel (must be launched under a per-line watcher, not as a background command)')
  .option('--follow', 'Keep the stream open. The only supported mode.')
  // No --since. The cursor is server-side, per subscriber: a reconnect resumes
  // from the last acknowledged record on its own. Offering the flag implied the
  // consumer owned the cursor, which it does not — and it was accepted and then
  // silently ignored, which three reviewers found independently. A flag that
  // does nothing is worse than no flag.
  .option('--wait-ms <ms>', 'Long-poll wait per round trip')
  .action(async (opts: { follow?: boolean; waitMs?: string }) => {
    const result = await runEvents({ follow: opts.follow, waitMs: opts.waitMs })
    // The exit code is the only structured thing a dead subscriber can still
    // say, and the harness surfaces it — so it is set deliberately, never 0 by
    // accident.
    process.exitCode = result.exit
  })

program
  .command('hook-diag')
  .description('Inspect or explicitly arm the bounded hook diagnostic log')
  .option('--enable', 'Enable diagnostics for 30 minutes using ~/.jerico/hooks/DIAG')
  .option('--disable', 'Disable the diagnostics flag')
  .option('-n, --tail <N>', 'Number of diagnostic records to show', '50')
  .option('--json', 'Emit machine-readable status and records')
  .action((opts: { enable?: boolean; disable?: boolean; tail?: string; json?: boolean }) => {
    runHookDiag({
      enable: opts.enable,
      disable: opts.disable,
      tail: Math.max(0, parseInt(opts.tail ?? '50', 10) || 50),
      json: opts.json
    })
    // Importing the daemon CLI also loads long-lived daemon modules. A
    // synchronous diagnostic command must not inherit their event-loop handles.
    process.exit(0)
  })

program
  .command('probe-fda')
  .description('Probe ~/Documents before opening macOS privacy settings (one-shot, exits 0 always)')
  .action(() => {
    const result = probeProtectedAccess()
    if (result.readable) {
      console.log('[bridge] probe-fda: Documents folder readable')
    } else {
      console.log('[bridge] probe-fda: Documents folder access blocked (EPERM)')
    }
    process.exit(0)
  })

program
  .command('check-fda')
  .description('Check ~/Documents readability (exit 0 = readable, exit 1 = blocked)')
  .action(() => {
    const result = probeProtectedAccess()
    if (result.readable) {
      console.log('[bridge] check-fda: Documents folder readable')
      process.exit(0)
    } else {
      console.log('[bridge] check-fda: Documents folder blocked')
      process.exit(1)
    }
  })

program
  .command('probe-keychain')
  .description('Probe Keychain ACL by writing+reading a throwaway test entry (exit 0 = functional, 1 = failed)')
  .action(() => {
    runProbeKeychain()
  })

program
  .command('heal-keychain')
  .description('Re-apply -T ACL flags to the existing token entry (exit 0 = healed, 1 = failed, 3 = no token)')
  .action(() => {
    runHealKeychain()
  })

program
  .command('probe-pty')
  .description('Smoke-test: verify node-pty loads and spawns (exit 0 = OK, 1 = FAIL). For CI and user debugging.')
  .action(() => {
    import('./commands/probe-pty.js').then(({ runProbePty }) => runProbePty())
  })

program
  .command('bridge-mcp')
  .description('Run the bundled Bridge MCP server (stdio)')
  .action(() => {
    // Default to stdio mode; config builders also set this in the spawned env,
    // but set it here defensively in case the subcommand is invoked directly.
    process.env['HTTP_MODE'] = process.env['HTTP_MODE'] ?? 'false'
    console.error('[bridge] bridge-mcp.start', { mode: 'stdio' })
    // Literal relative require so pkg's static analyzer bundles bridge-mcp.cjs
    // into the snapshot automatically (a computed path.resolve() require is invisible
    // to pkg and gets dropped, causing MODULE_NOT_FOUND at runtime).
    require('./bridge-mcp.cjs')
  })

program
  .command('codegraph', { hidden: true })
  .description('Run the bundled codegraph MCP server (internal — spawned + supervised by the daemon)')
  // codegraph.cjs does its OWN argv parsing (argv[2] = structural|adoption-stats|transcript-stats|…
  // with their own --flags). Commander must NOT validate those — pass everything through
  // transparently, else `bridge-agent codegraph structural --pattern X` dies on
  // "unknown option '--pattern'" before the bundle ever runs.
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    // #380 Gap 3: inside the pkg binary the daemon re-enters itself as
    // `bridge-agent codegraph [sub …]` (client.ts isPkg spawn). Literal relative require
    // so pkg bundles codegraph.cjs into the snapshot (same reason as bridge-mcp above).
    //
    // codegraph.cjs parses process.argv directly and expects its OWN subcommand at
    // argv[2] ([node, script, <sub>, …]). But under pkg the invocation is
    //   [binPath, snapshotEntry, 'codegraph', <sub>, …]
    // so 'codegraph' sits at argv[2] and the real sub is at argv[3] — misaligned by one,
    // which made every CLI sub silently fall through to server-start. Drop our own
    // 'codegraph' token so the bundle's argv[2] lands on the sub (no-sub server case
    // still works: argv[2] becomes undefined → not a known sub → MCP server starts).
    // Rebuild process.argv so the bundle sees ONLY its own subcommand + flags at argv[2+]
    // ([node, script, <sub>, …]). Take everything AFTER our 'codegraph' command token,
    // dropping the token itself and any preceding global options (e.g. `--profile dev`,
    // which the bundle reads from env, not argv). Locate the token by value while skipping a
    // false match that is actually the `--profile` VALUE (`--profile codegraph`). Bare
    // `codegraph` (the daemon's server spawn) yields no operands → argv[2] undefined → the
    // bundle starts its MCP server, unchanged.
    let cgIdx = -1
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === 'codegraph' && process.argv[i - 1] !== '--profile') { cgIdx = i; break }
    }
    const subArgs = cgIdx !== -1 ? process.argv.slice(cgIdx + 1) : []
    process.argv = [process.argv[0] ?? '', process.argv[1] ?? '', ...subArgs]
    require('./codegraph.cjs')
  })

// Electron 34 + ELECTRON_RUN_AS_NODE shifts argv: the script path appears at
// argv[2] instead of argv[1], causing commander to treat it as an unknown command.
// Detect by checking if argv[2] looks like an absolute .js path and slice accordingly.
const _argv2 = process.argv[2] ?? ''
const _parsedArgv =
  _argv2.startsWith('/') && (_argv2.endsWith('.js') || _argv2.endsWith('.cjs'))
    ? process.argv.slice(1)
    : process.argv
program.parse(_parsedArgv)
