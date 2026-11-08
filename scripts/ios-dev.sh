#!/bin/sh
# Run the app on the iOS simulator with live reload: CSS and React changes show up in a few
# seconds without a rebuild (Rust and native iOS changes still rebuild). Usage:
#   npm run ios:dev                    # the default simulator below
#   npm run ios:dev -- "iPhone Air"    # another simulator, by name
#
# `tauri dev` and `android:dev` start the Vite dev server on port 1420, and it refuses to start a
# second time. When one is already running, iOS shares it instead of starting its own; otherwise
# `tauri ios dev` fails with "Port 1420 is already in use" and then "failed to connect to the Tauri CLI".
set -e

cd "$(dirname "$0")/.."
DEVICE="${1:-iPhone 18 Pro}"

if nc -z localhost 1420 2>/dev/null; then
  echo "Using the dev server already running on port 1420."
  exec npx tauri ios dev "$DEVICE" --config '{"build":{"beforeDevCommand":""}}'
fi

exec npx tauri ios dev "$DEVICE"
