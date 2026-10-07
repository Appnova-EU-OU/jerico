#!/usr/bin/env bash
# install-sim-prereqs.sh — Idempotent iOS Simulator prerequisites installer
# Usage: ./install-sim-prereqs.sh
# Exits 0 when all prerequisites are satisfied.

set -euo pipefail

STEP="pre_check"
INSTALL_TIMEOUT=1800   # 30 minutes for xcode-select GUI polling
POLL_INTERVAL=5        # seconds
IDB_PATH="${HOME}/.local/bin/idb"

# ── Helpers ──────────────────────────────────────────────────────────────────

log_step() {
  STEP="$1"
  echo "STEP:${STEP}"
}

log_info() {
  echo "[info] $*"
}

log_error() {
  echo "[error] $*" >&2
}

has_xcrun() {
  xcode-select -p >/dev/null 2>&1
}

has_brew() {
  command -v brew >/dev/null 2>&1
}

has_idb_companion() {
  command -v idb_companion >/dev/null 2>&1
}

has_fb_idb() {
  test -x "$IDB_PATH"
}

has_booted_simulator() {
  local out
  out=$(xcrun simctl list devices booted --json 2>/dev/null) || return 1
  echo "$out" | grep -q '"state" *: *"Booted"'
}

# ── Step 1: Xcode CLI tools ──────────────────────────────────────────────────

log_step "xcode_install"

if ! has_xcrun; then
  log_info "Xcode CLI tools not found. Launching installer GUI..."
  xcode-select --install || true

  log_info "Polling for xcode-select -p (max ${INSTALL_TIMEOUT}s)..."
  waited=0
  while ! has_xcrun; do
    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
    if [[ $waited -ge $INSTALL_TIMEOUT ]]; then
      log_error "Timed out waiting for Xcode CLI tools install. If you cancelled the GUI, please re-run."
      exit 1
    fi
  done
  log_info "Xcode CLI tools detected."
else
  log_info "Xcode CLI tools already present."
fi

# ── Step 2: Homebrew ─────────────────────────────────────────────────────────

log_step "brew_check"

if ! has_brew; then
  log_error "Homebrew is not installed. Please install it first: https://brew.sh"
  exit 11
fi
log_info "Homebrew OK."

# ── Step 3: idb-companion (native) ───────────────────────────────────────────

log_step "idb_install"

if ! has_idb_companion; then
  log_info "Installing idb-companion via Homebrew..."
  brew install facebook/fb/idb-companion
else
  log_info "idb-companion already present."
fi

# ── Step 4: fb-idb (Python CLI) ──────────────────────────────────────────────

if ! has_fb_idb; then
  log_info "Installing fb-idb via pip3..."
  pip3 install --user fb-idb
  if ! has_fb_idb; then
    USER_BASE="$(python3 -m site --user-base 2>/dev/null || true)"
    if [[ -n "$USER_BASE" && -x "${USER_BASE}/bin/idb" ]]; then
      mkdir -p "$(dirname "$IDB_PATH")"
      ln -sf "${USER_BASE}/bin/idb" "$IDB_PATH"
      log_info "Symlinked idb from ${USER_BASE}/bin/idb to $IDB_PATH"
    fi
  fi
  # Ensure ~/.local/bin is on PATH for future shells
  if ! grep -q "${HOME}/.local/bin" "${HOME}/.zshrc" 2>/dev/null; then
    echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> "${HOME}/.zshrc"
    log_info "Added ~/.local/bin to ~/.zshrc"
  fi
  if [[ -f "${HOME}/.bash_profile" ]] && ! grep -q "${HOME}/.local/bin" "${HOME}/.bash_profile" 2>/dev/null; then
    echo 'export PATH="${HOME}/.local/bin:${PATH}"' >> "${HOME}/.bash_profile"
    log_info "Added ~/.local/bin to ~/.bash_profile"
  fi
else
  log_info "fb-idb already present."
fi

# ── Step 5: Boot a default simulator ─────────────────────────────────────────

log_step "sim_boot"

if has_booted_simulator; then
  log_info "Simulator already booted."
else
  log_info "No booted simulator found. Attempting to boot iPhone 15..."
  # Find the first available iPhone 15 device
  udid=""
  udid=$(xcrun simctl list devices available --json 2>/dev/null \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if 'iPhone 15' in d.get('name', '') and d.get('isAvailable', True):
            print(d['udid'])
            raise SystemExit
" 2>/dev/null || true)

  if [[ -z "${udid:-}" ]]; then
    log_info "No iPhone 15 found; trying any available iPhone..."
    udid=$(xcrun simctl list devices available --json 2>/dev/null \
      | python3 -c "
import sys, json
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if 'iPhone' in d.get('name', '') and d.get('isAvailable', True):
            print(d['udid'])
            raise SystemExit
" 2>/dev/null || true)
  fi

  if [[ -n "${udid:-}" ]]; then
    xcrun simctl boot "$udid" || true
    log_info "Booted simulator $udid"
    echo "BOOTED_UDID:$udid"
  else
    log_info "No simulator device found to boot. Please create one in Xcode → Window → Devices and Simulators."
  fi
fi

if ! has_fb_idb; then
  log_error "idb installed but not at expected path $IDB_PATH"
  exit 12
fi

log_step "done"
log_info "All prerequisites satisfied."
