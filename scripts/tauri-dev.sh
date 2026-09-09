#!/bin/sh
# Dev helper: sign the tauri dev binary with a stable self-signed identity so
# the macOS Application Firewall "allow incoming connections" rule keeps
# applying after every rebuild. Usage:
#   ./scripts/tauri-dev.sh            # start dev (auto-signs on every rebuild)
#   ./scripts/tauri-dev.sh --sign     # sign whatever binary exists and exit
set -e

cd "$(dirname "$0")/.."
IDENTITY="ai-usage-tracker-dev"
BIN="src-tauri/target/debug/ai-usage-tracker"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

ensure_identity() {
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    return
  fi
  echo "Creating self-signed code signing identity '$IDENTITY' (one-time)..."
  TMP=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -days 3650 -nodes -subj "/CN=$IDENTITY" \
    -addext "extendedKeyUsage = codeSigning" >/dev/null 2>&1
  openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -out "$TMP/id.p12" -passout pass:dev >/dev/null 2>&1
  security import "$TMP/id.p12" -k "$KEYCHAIN" -P dev -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  security add-trusted-cert -r trustAsRoot -k "$KEYCHAIN" "$TMP/cert.pem" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}

sign_binary() {
  if [ -f "$BIN" ]; then
    codesign --force --deep --sign "$IDENTITY" "$BIN" 2>/dev/null || \
      echo "warning: codesign of $BIN failed"
  fi
}

if [ "$1" = "--sign" ]; then
  ensure_identity
  sign_binary
  exit 0
fi

ensure_identity

# Watch for binary rebuilds while `tauri dev` runs, signing after each build.
(
  last_mtime=0
  while true; do
    if [ -f "$BIN" ]; then
      mtime=$(stat -f %m "$BIN" 2>/dev/null || echo 0)
      if [ "$mtime" != "$last_mtime" ]; then
        sleep 2
        sign_binary
        last_mtime=$mtime
      fi
    fi
    sleep 2
  done
) &
WATCHER=$!
trap 'kill $WATCHER 2>/dev/null' EXIT

npx tauri dev
