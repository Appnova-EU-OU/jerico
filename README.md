# Jerico — open client packages

Jerico runs the AI coding agents installed on your machine (Claude Code, Codex,
Kimi, Qwen, OpenCode, a plain shell and others) in local terminals and lets you
drive and orchestrate them side by side from a browser. This repository is the
part that runs on your machine; the hosted service it connects to is not in it.

| Path | What it is | Licence |
|---|---|---|
| `packages/daemon` | Local agent (`bridge-agent` on npm): runs AI CLI sessions in local terminals and connects them to the service | MIT |
| `packages/mcp-server` | MCP server that exposes project tools to agent sessions | Apache-2.0 |
| `packages/codegraph` | Local code-graph MCP server (tree-sitter indexing, symbol search) | Apache-2.0 |
| `packages/inspect-runtime` | In-page runtime for click-to-inspect in previews | Apache-2.0 |
| `packages/shared` | Protocol types and constants shared by the packages above | Apache-2.0 |
| `apps/desktop` | macOS menu-bar app that installs and supervises the local agent | Apache-2.0 |

## Download the desktop app

Signed and notarized macOS builds (Apple silicon and Intel) are published on the
[releases page](https://github.com/Appnova-EU-OU/jerico/releases). The app
installs the local agent and keeps it running. The agent alone is also on npm:
`npm install -g bridge-agent`.

Access to the hosted service is currently by invitation.

## Local and hosted

| Runs on your machine (this repository) | Runs on the hosted service (not open source) |
|---|---|
| The agent, which starts and owns every terminal session | Accounts, sign-in, workspaces and projects |
| The AI CLIs themselves, with your own logins | The web interface |
| The MCP servers your agent sessions talk to | Orchestration: plans, task queues, dispatching work to sessions |
| The desktop app | Relaying traffic between your browser and your machine |

By default the agent connects to `wss://lcars.jerico.appnova.io/ws/daemon` and
signs in at `https://lcars.jerico.appnova.io`. **Self-hosting is not offered:**
the service is not published, and the client is only supported against the
hosted endpoint.

### What the agent sends to the service

- **Terminal output** of the sessions you open.
- **Agent metadata:** which AI CLIs are installed, whether they are signed in,
  their versions and the models they offer, and each session's state.
- **Usage readings:** per session, the context-window fill and token counts;
  per agent, prompt and token counts over the last five hours, estimated from
  that agent's own local session logs.
- **Machine readings:** CPU load, memory use and battery level.
- **What you ask for from the browser:** directory listings, file contents
  and edits, git status and diffs, and project file trees for folders you open;
  your Claude Code session titles when you pick one to resume; the pages of a
  local development server you preview; iOS Simulator frames when you open a
  simulator panel.

The agent runs as your user account, with no sandbox, and starts the AI CLIs
with their permission prompts turned off (for example Claude Code with
`--dangerously-skip-permissions`, Codex with
`--dangerously-bypass-approvals-and-sandbox`, Qwen with `--yolo`) so that
sessions can run unattended. `bridge-agent auth` prints this disclosure before
it connects.

### Other AI tools' credentials

To show how much of each plan's usage limit is left, the agent **reads the
login credentials other AI CLIs have already stored on your machine** and asks
each vendor for your current usage:

| Agent | Credential read | Usage endpoint called |
|---|---|---|
| Claude Code | `~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials` | `api.anthropic.com/api/oauth/usage` |
| Codex | `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`) | `chatgpt.com/backend-api/wham/usage` |
| GitHub Copilot | `GH_TOKEN` or `GITHUB_TOKEN` from the agent's environment, else `githubToken` in the agent's settings file, else the GitHub CLI's `~/.config/gh/hosts.yml` | `api.github.com/copilot_internal/user` |
| Kimi | `KIMI_CODE_API_KEY` or `KIMI_API_KEY` from the agent's environment, else `kimiApiKey` in the agent's settings file, else `~/.kimi-code/credentials/kimi-code.json` | `api.kimi.com/coding/v1/usages` |
| Antigravity | first the running `agy` process on localhost, which needs no credential; else `~/.gemini/antigravity-cli/antigravity-oauth-token`, or the Gemini CLI's `~/.gemini/oauth_creds.json`. When you open the usage view it may also run `agy -p /usage` | `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`, or the local `agy` process |

These reads are read-only: the agent never writes, refreshes or rotates
another tool's credential, never reads browser cookies, and never shows a
Keychain prompt from a background refresh. The credentials go only to the
vendor they belong to, about once every five minutes per installed agent.
Several of these endpoints are not documented public APIs, so a vendor change
can break a reading without notice. The readings themselves stay on your
machine: the agent serves them on its local health endpoint
(`127.0.0.1`), where the desktop app shows them.

## Build and run from source

Requirements: macOS or Linux, Node.js 22 or newer, pnpm 10 (`npx -y pnpm@10 …`
works without a global install), and [Bun](https://bun.sh) 1.3 for the daemon
and shared tests. The desktop app builds on macOS only.

```bash
pnpm install --frozen-lockfile
pnpm -r typecheck

# Build order: codegraph and inspect-runtime first, the daemon bundles both.
pnpm --filter @bridge/codegraph build
pnpm --filter @jerico/inspect-runtime build
pnpm --filter @bridge/mcp-server build
(cd packages/daemon && node scripts/build.mjs)
node packages/daemon/dist/index.js --version
```

### Run the agent against the hosted service

Use a profile name of your own so a source build never shares configuration
with an installed copy of the agent (the default profile is the one the
desktop app and the npm package use). A new named profile has no endpoints
yet, so `auth` names all three. A successful `auth` saves the daemon endpoint
in the profile and `start` reads it from there; pass the same three flags if
you ever run `auth` again:

```bash
node packages/daemon/dist/index.js --profile src auth \
  --server https://lcars.jerico.appnova.io \
  --connect-page https://jerico.appnova.io/connect \
  --daemon-server wss://lcars.jerico.appnova.io/ws/daemon
# auth prints the connect page, then asks for the token it gives you
node packages/daemon/dist/index.js --profile src start
```

`start` registers the agent with launchd for that profile and keeps it
running; `node packages/daemon/dist/index.js --profile src uninstall` removes
it again. That background service is macOS-only. On Linux, or to debug, run
the agent in the foreground instead:

```bash
BRIDGE_DAEMON=1 node packages/daemon/dist/index.js --profile src start
```

Each profile keeps its settings in `~/.jerico/profiles/<name>/settings.json`.

### Run the tests safely

Some daemon tests exercise the install and uninstall code. They mock the
system calls, but run them the way CI does, with a throw-away home directory
and no profile, so nothing can reach your real configuration:

```bash
pnpm --filter @bridge/mcp-server test
node --test packages/codegraph/src/__tests__/*.test.mjs
(cd packages/shared && bun test)
(cd apps/desktop && node --test)
(cd packages/daemon && HOME="$(mktemp -d)" BRIDGE_PROFILE= bun test)
```

### Package the desktop app (unsigned)

```bash
(cd packages/daemon && node scripts/pkg-build.mjs --target=macos-arm64)   # or macos-x64
cp packages/daemon/dist/bin/bridge-agent-macos-arm64 apps/desktop/resources/bridge-agent
cp "$(dirname "$(node -p "require.resolve('node-pty/package.json', { paths: ['packages/daemon'] })")")/prebuilds/darwin-arm64/spawn-helper" apps/desktop/resources/spawn-helper
cd apps/desktop && pnpm build
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac --dir --publish never
```

The app lands in `apps/desktop/dist/mac-arm64/`. It is unsigned, so macOS will
only open it after you allow it in System Settings → Privacy & Security.

Even unsigned, the build's signing hooks look for a notarization credential.
Unless the `APPLE_API_KEY*` or `NOTARY_KEYCHAIN_PROFILE` environment variables
are set, they run `security find-generic-password -s com.apple.notarytool -a
jerico-notary` against your Keychain. The lookup only reads. When the item is
absent, the build skips notarization and continues.

## More

[CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute ·
[SECURITY.md](SECURITY.md) — reporting vulnerabilities ·
[LICENSE.md](LICENSE.md) — the licence map ·
[TRADEMARKS.md](TRADEMARKS.md) — the Jerico name and logo
