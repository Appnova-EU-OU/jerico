import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { getGlobalHooksDir, getHookScriptPath } from '../profile.js'

import {
  HOOK_ROUTE_PATH,
  HEADER_TOKEN,
  HEADER_PROTOCOL,
  HEADER_PROTOCOL_VERSION,
  HEADER_AGENT_ID,
  HEADER_INSTANCE_ID,
  DESCRIPTOR_ENV_VAR,
  DESCRIPTOR_FIELD_URL,
  DESCRIPTOR_FIELD_TOKEN,
  HOOK_PROTOCOL,
  HOOK_PROTOCOL_VERSION,
  HEADER_EVENT_NAME,
  HOOK_ENV_EVENT_NAME,
  HOOK_ENV_STDOUT
} from './protocol.js'

export const HOOK_SCRIPT_V1 = `#!/bin/sh
# Opt-in: providers that read a decision from the hook's stdout set
# ${HOOK_ENV_STDOUT}. Unset for every other target, where this is a no-op.
hook_stdout() {
  if [ -n "\${${HOOK_ENV_STDOUT}:-}" ]; then
    printf '%s\\n' "\${${HOOK_ENV_STDOUT}}"
  fi
  return 0
}
diag=0
diag_dir="\${HOME:-}/.jerico/hooks"
diag_flag="$diag_dir/DIAG"
if [ -n "\${BRIDGE_PROFILE:-}" ] && [ "\${BRIDGE_PROFILE}" != "?" ]; then
  log_dir="\${HOME:-}/.jerico/profiles/\${BRIDGE_PROFILE}"
else
  log_dir="\${HOME:-}/.jerico"
fi
diag_log="$log_dir/hook-debug.log"
if [ -n "\${JERICO_HOOK_DIAG:-}" ] || { [ -f "$diag_flag" ] && [ ! -L "$diag_flag" ]; }; then
  if [ -n "\${HOME:-}" ] && [ ! -L "$log_dir" ] && [ ! -L "$diag_log" ]; then
    (umask 077; mkdir -p "$log_dir" && chmod 700 "$log_dir" && : > "$diag_log") 2>/dev/null && diag=1
  fi
fi
if [ "$diag" -eq 1 ]; then
  diag_ts=$(/bin/date +%s 2>/dev/null || printf '?')
  diag_inv="$diag_ts-$$"
  diag_safe() {
    case "$1" in
      ''|*[!A-Za-z0-9._:-]*) printf '?' ;;
      *) printf '%s' "$1" ;;
    esac
  }
  diag_profile=$(diag_safe "\${BRIDGE_PROFILE:-?}")
  diag_panel=$(diag_safe "\${BRIDGE_PANEL_ID:-?}")
  diag_inst=$(diag_safe "\${BRIDGE_PANEL_INSTANCE_ID:-?}")
fi
diag_line() {
  [ "$diag" -eq 1 ] || return 0
  printf 'ts=%s inv=%s pid=%s profile=%s panel=%s inst=%s stage=%s%s\n' "$diag_ts" "$diag_inv" "$$" "$diag_profile" "$diag_panel" "$diag_inst" "$1" "\${2:-}" >> "$diag_log" 2>/dev/null || :
}
diag_line enter
if [ -z "\${BRIDGE_PANEL_ID:-}" ]; then
  diag_line no_panel_id
  hook_stdout
  exit 0
fi
if [ -z "\${${DESCRIPTOR_ENV_VAR}:-}" ]; then
  diag_line no_descriptor ' detail=var=unset'
  hook_stdout
  exit 0
fi
if [ ! -r "\${${DESCRIPTOR_ENV_VAR}}" ]; then
  diag_line no_descriptor ' detail=var=unreadable'
  hook_stdout
  exit 0
fi
url=$(grep -o '"${DESCRIPTOR_FIELD_URL}": *"[^"]*"' "\${${DESCRIPTOR_ENV_VAR}}" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
token=$(grep -o '"${DESCRIPTOR_FIELD_TOKEN}": *"[^"]*"' "\${${DESCRIPTOR_ENV_VAR}}" | head -1 | grep -o '"[^"]*"$' | tr -d '"')
if [ -z "$url" ] || [ -z "$token" ]; then
  if [ -z "$url" ] && [ -z "$token" ]; then
    diag_line no_fields ' detail=both=empty'
  elif [ -z "$url" ]; then
    diag_line no_fields ' detail=url=empty'
  else
    diag_line no_fields ' detail=token=empty'
  fi
  hook_stdout
  exit 0
fi
payload=$(cat)
# Opt-in: providers whose payload carries no event name (agy) declare it
# in ${HOOK_ENV_EVENT_NAME}; unset means no extra header is sent.
if [ -n "\${${HOOK_ENV_EVENT_NAME}:-}" ]; then
  set -- -H "${HEADER_EVENT_NAME}: \${${HOOK_ENV_EVENT_NAME}}"
else
  set --
fi
diag_line post ' detail=host=loopback'
http=$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 2 -X POST "$url" \\
  -H "${HEADER_TOKEN}: $token" \\
  -H "${HEADER_PROTOCOL}: ${HOOK_PROTOCOL}" \\
  -H "${HEADER_PROTOCOL_VERSION}: ${HOOK_PROTOCOL_VERSION}" \\
  -H "${HEADER_AGENT_ID}: \${BRIDGE_PANEL_ID}" \\
  -H "${HEADER_INSTANCE_ID}: \${BRIDGE_PANEL_INSTANCE_ID}" \\
  -H "Content-Type: application/json" \\
  "$@" \\
  -d "$payload" 2>/dev/null)
curl_status=$?
diag_line done " detail=curl=$curl_status http=\${http:-000}"
hook_stdout
exit 0
`

export function hookScriptPath(): string {
  return process.env.JERICO_HOOK_SCRIPT_PATH_OVERRIDE || getHookScriptPath()
}

export function ensureHookScript(): void {
  const dir = getGlobalHooksDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const script = hookScriptPath()
  
  if (existsSync(script)) {
    const existing = readFileSync(script, 'utf-8')
    if (existing === HOOK_SCRIPT_V1) return
  }
  
  writeFileSync(script, HOOK_SCRIPT_V1, { mode: 0o755 })
}
