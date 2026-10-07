# bridge-agent

Connects your local AI tools (Claude Code, Qwen CLI, Kimi, Codex, etc.) to Jerico — a browser-based multi-agent orchestration platform.

## Requirements

- Node.js 20 or newer
- An invitation to the hosted Jerico service (access is currently by invitation)
- The AI agents you want to use, each installed and signed in

## Installation

```bash
npm install -g bridge-agent
```

## Quick Start

### 1. Authenticate

```bash
bridge-agent auth
```

With no flags, `auth` uses the hosted service's endpoints: it signs in at
`https://lcars.jerico.appnova.io`, prints the token page
`https://jerico.appnova.io/connect`, asks you to paste the token it gives you,
and saves the daemon endpoint `wss://lcars.jerico.appnova.io/ws/daemon`. If you
already have a token: `bridge-agent auth --token YOUR_TOKEN`.

Before it connects, `auth` prints what the agent will do on your machine and
asks you to accept it.

### 2. Start

```bash
bridge-agent start
```

On macOS, `start` registers the agent with launchd and keeps it running. On
Linux, or to debug, run it in the foreground with
`BRIDGE_DAEMON=1 bridge-agent start`.

The daemon will:
- Connect to the Jerico service over WebSocket
- Auto-detect installed AI agents on your machine
- Spawn PTY sessions for terminal emulation
- Report usage readings (context window, prompt and token counts)

### 3. Done — open Jerico in your browser

Your machine will appear in the Machines page. Spawn panels and orchestrate agents from the web UI.

## What runs where, and what is sent

The agent, the AI CLIs and the MCP servers run on your machine. Accounts, the
web interface, orchestration and the relay between your browser and your
machine run on the hosted service, which is not open source. Self-hosting is
not offered.

The agent sends the service the terminal output of the sessions you open,
which AI CLIs are installed and signed in, usage readings estimated from those
CLIs' local session logs, CPU, memory and battery readings, and whatever you
ask for from the browser (directory listings, file contents and edits, git
status and diffs, previews of a local dev server, iOS Simulator frames). It
runs as your user, with no sandbox, and starts the AI CLIs with their
permission prompts off (for example Claude Code with
`--dangerously-skip-permissions`) so sessions can run unattended.

To show how much of each plan's limit is left, the agent **reads other AI
CLIs' stored credentials** (Claude Code, Codex, GitHub Copilot, Kimi,
Antigravity), read-only, and asks each vendor's usage endpoint (or, for
Antigravity, the running `agy` process) for your current usage.
Several of those endpoints are not documented public APIs. The credentials go
only to their own vendor, and the readings stay on your machine. The source
repository's README lists every file, Keychain item, environment variable and
endpoint involved: <https://github.com/Appnova-EU-OU/jerico>.

## Commands

| Command | Description |
|---|---|
| `bridge-agent auth [options]` | Authenticate with the Jerico service |
| `bridge-agent start` | Start the daemon (connects to the endpoint saved by `auth`) |
| `bridge-agent status` | Show current connection status and config |
| `bridge-agent logs [-f]` | Show the daemon's log |
| `bridge-agent stop` | Stop the daemon |
| `bridge-agent uninstall` | Remove the background service |

Run `bridge-agent --help` for the full list.

## Auth Options

```
--server, -s          Auth API origin (default: https://lcars.jerico.appnova.io)
--daemon-server       Daemon WebSocket URL (default: wss://lcars.jerico.appnova.io/ws/daemon)
--connect-page        Token-generation page (default: https://jerico.appnova.io/connect)
--token, -t           Use an existing daemon token; skip the connect-page step
--no-browser          Without --token, print the auth URL and exit instead of prompting
```

The defaults apply to the default profile. A `--profile <name>` other than
`dev` has no defaults, so its first `auth` needs `--server`, `--connect-page`
and `--daemon-server`.

On re-auth, `--daemon-server` may repeat the configured URL but cannot change it silently. To repoint an
existing installation, update `server` in `~/.jerico/settings.json` explicitly before re-authenticating.

## Configuration

Settings are stored in `~/.jerico/settings.json` (a named profile uses
`~/.jerico/profiles/<name>/settings.json`). The daemon token goes into the
macOS Keychain when it is available, otherwise into that file with mode 0600.

### Claude Quota Tracking

To change your Claude tier, open Bridge in a browser and go to **Settings → Connected Machines**. Select your machine and use the tier dropdown.

Alternatively, edit `~/.jerico/settings.json` directly:

```json
{
  "claudeTier": "pro"
}
```

Supported tiers: `free` (10 prompts/5h), `pro` (40), `max_5x` (200), `max_20x` (200)

### Bridge MCP is per-panel

`bridge-mcp` is the MCP stdio server used by each panel. The Jerico daemon
spawns it automatically with per-panel credentials via `--mcp-config`. You
do not need to register `bridge-mcp` as a global MCP server in Claude Code
— if you do, it will fail with `Missing env vars for stdio mode` because
per-panel context (workspace, project, panel IDs) isn't available outside
a daemon-spawned panel.

## Supported Agents

| Agent | Key | Notes |
|---|---|---|
| Claude Code | `claude` | MCP + session support |
| Qwen CLI | `qwen` | MCP + session support |
| Kimi Code | `kimi` | MCP + session support |
| Codex CLI | `codex` | MCP enabled |
| Antigravity | `agy` | MCP enabled |
| Ollama | `ollama` | CLI only |
| Aider | `aider` | MCP enabled |
| Shell | `sh` | Always available |

## Troubleshooting

**Daemon not connecting?**
```bash
bridge-agent status
# Check server URL and token are correct
```

**Need to re-authenticate?**
```bash
bridge-agent auth --token YOUR_NEW_TOKEN
```

**View logs:**
```bash
bridge-agent logs -f
```

## License

MIT
