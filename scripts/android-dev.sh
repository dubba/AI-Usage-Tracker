#!/bin/sh
# Run the app on the Android emulator with live reload: CSS and React changes show up in a
# few seconds without a rebuild (Rust and native Android changes still rebuild). Usage:
#   npm run android:dev
#
# Do not pass a device argument to `tauri android dev`; with no device it finds the running
# emulator (passing a device stops at "Opening Android Studio").
#
# `tauri dev` and `ios:dev` start the Vite dev server on port 1420, and it refuses to start a
# second time. When one is already running, Android shares it instead of starting its own;
# otherwise `tauri android dev` fails with "Port 1420 is already in use".
set -e

cd "$(dirname "$0")/.."

if [ -d /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
fi

has_config=0
for arg in "$@"; do
  case "$arg" in
    --config|--config=*|-c|-c=*)
      has_config=1
      break
      ;;
  esac
done

if [ "$has_config" -eq 0 ] && (nc -z 127.0.0.1 1420 2>/dev/null || nc -z localhost 1420 2>/dev/null); then
  echo "Using the dev server already running on port 1420."
  exec npx tauri android dev "$@" --config '{"build":{"beforeDevCommand":""}}'
fi

exec npx tauri android dev "$@"
