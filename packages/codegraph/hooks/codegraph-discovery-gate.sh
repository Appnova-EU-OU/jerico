#!/bin/bash
# codegraph-discovery-gate.sh — thin wrapper around the .mjs PreToolUse hook.
# Keeps the same invocation shape as the other ~/.claude/hooks/*.sh scripts.
# The hook itself is NON-BLOCKING: always exits 0, passthrough if codegraph down.
#
# Use this in settings.json instead of the .mjs if you prefer a shell entry:
#   "command": "bash /abs/path/codegraph/hooks/codegraph-discovery-gate.sh"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/codegraph-discovery-gate.mjs"
