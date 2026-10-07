#!/usr/bin/env bash
# Download the pinned gitleaks release into a tools directory, verify its
# SHA-256 against the value pinned below, and print the binary's path.
# Nothing is installed system-wide.
#
#   GITLEAKS_TOOLS_DIR  where to keep the binary (default: $TMPDIR/gitleaks-tools)
set -euo pipefail

VERSION=8.30.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)        PLATFORM=darwin_arm64; SHA256=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64)       PLATFORM=darwin_x64;   SHA256=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Linux-x86_64)        PLATFORM=linux_x64;    SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux-aarch64|Linux-arm64) PLATFORM=linux_arm64; SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) echo "fetch-gitleaks: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac

DIR="${GITLEAKS_TOOLS_DIR:-${TMPDIR:-/tmp}/gitleaks-tools}/gitleaks-${VERSION}-${PLATFORM}"
BIN="$DIR/gitleaks"
if [ -x "$BIN" ] && [ -f "$DIR/.verified" ]; then
  echo "$BIN"
  exit 0
fi

mkdir -p "$DIR"
TARBALL="$DIR/gitleaks.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_${PLATFORM}.tar.gz"
curl -fsSL --retry 3 -o "$TARBALL" "$URL"

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TARBALL" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
fi
if [ "$ACTUAL" != "$SHA256" ]; then
  echo "fetch-gitleaks: checksum mismatch for $URL" >&2
  echo "  expected $SHA256" >&2
  echo "  actual   $ACTUAL" >&2
  rm -f "$TARBALL"
  exit 3
fi

tar -xzf "$TARBALL" -C "$DIR" gitleaks
rm -f "$TARBALL"
chmod +x "$BIN"
touch "$DIR/.verified"
echo "$BIN"
