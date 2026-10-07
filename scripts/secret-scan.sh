#!/usr/bin/env bash
# Scan a directory tree (default: the repository root) for secrets with the
# pinned gitleaks release and this repository's .gitleaks.toml. No git history
# is read. Exits non-zero when gitleaks reports a finding.
#
#   scripts/secret-scan.sh [dir] [config]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TARGET="${1:-$ROOT}"
CONFIG="${2:-$ROOT/.gitleaks.toml}"
GITLEAKS="$("$HERE/fetch-gitleaks.sh")"
"$GITLEAKS" version
exec "$GITLEAKS" dir "$TARGET" --config "$CONFIG" --no-banner --redact --verbose --exit-code 1
