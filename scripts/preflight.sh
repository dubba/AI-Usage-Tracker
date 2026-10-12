#!/usr/bin/env bash
# Runs the checks CI's Validate workflow runs, against a clean checkout of HEAD, so
# gitignored local files (generated Android Kotlin, icons, dist) cannot hide a failure.
# Windows tests are the only part of Validate this cannot reproduce.
#
#   npm run preflight
#   PREFLIGHT_CACHE_DIR=/some/dir npm run preflight    # separate cache root (cold-run timing)
#
# Everything it writes (worktree, Cargo target, npm cache, advisory database) lives under
# PREFLIGHT_CACHE_DIR. It defaults to /Volumes/External/_caches when that drive is mounted,
# otherwise ~/.cache (about 5 GB of Cargo output). PREFLIGHT_ADVISORY_DB overrides the
# advisory database location the same way.
set -uo pipefail

repo=$(git rev-parse --show-toplevel)
if [ -d /Volumes/External ]; then
  default_cache=/Volumes/External/_caches/ai-usage-tracker-preflight
  default_db=/Volumes/External/_caches/cargo/advisory-db
else
  default_cache=$HOME/.cache/ai-usage-tracker-preflight
  default_db=$HOME/.cache/advisory-db
fi
cache_root=${PREFLIGHT_CACHE_DIR:-$default_cache}
advisory_db=${PREFLIGHT_ADVISORY_DB:-$default_db}
echo "cache: $cache_root"
ndk_version=27.2.12479018
sdk=${ANDROID_HOME:-$HOME/Library/Android/sdk}
manifest=src-tauri/Cargo.toml

mkdir -p "$cache_root/work" "$cache_root/target" "$cache_root/npm" || exit 1
work=$(mktemp -d "$cache_root/work/run.XXXXXX")
wt=$work/checkout
logs=$work/logs
mkdir -p "$logs"
export CARGO_TARGET_DIR=$cache_root/target
export npm_config_cache=$cache_root/npm

cleanup() {
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

names=(); secs=(); states=()
failed=0

# step <name> <fail|warn> <command...>: runs in the worktree, keeps going on failure.
step() {
  local name=$1 kind=$2 start state
  shift 2
  start=$(date +%s)
  printf '==> %s\n' "$name"
  if (cd "$wt" 2>/dev/null || cd "$repo"; "$@") >"$logs/${#names[@]}.log" 2>&1; then
    state=pass
  elif [ "$kind" = warn ]; then
    state=WARN
  else
    state=FAIL
    failed=1
  fi
  if [ "$state" != pass ]; then tail -n 25 "$logs/${#names[@]}.log"; fi
  names+=("$name"); secs+=($(( $(date +%s) - start ))); states+=("$state")
}

skip() {
  printf '==> %s (skipped: %s)\n' "$1" "$2"
  names+=("$1"); secs+=(0); states+=(skip)
}

ndk_bin=$(ls -d "$sdk"/ndk/$ndk_version/toolchains/llvm/prebuilt/*/bin 2>/dev/null | head -n 1)

android_check() {
  CC_aarch64_linux_android="$ndk_bin/aarch64-linux-android24-clang" \
    AR_aarch64_linux_android="$ndk_bin/llvm-ar" \
    cargo check --locked --manifest-path $manifest --target aarch64-linux-android --lib
}

step "worktree of HEAD" fail git -C "$repo" worktree add --detach "$wt" HEAD
[ -d "$wt" ] || { echo "could not create the worktree"; exit 1; }

step "npm ci" fail npm ci
step "npm run check" fail npm run check
step "npm test" fail npm test
step "npm run test:* scripts" fail bash -c \
  'npm run test:resolve-version && npm run test:sidestore-source && npm run test:gemini-quota-probe && npm run test:workflows'
step "npm run build" fail npm run build
step "cargo fmt --check" fail cargo fmt --manifest-path $manifest --check
step "cargo clippy (debug)" fail cargo clippy --locked --manifest-path $manifest --all-targets -- -D warnings
step "cargo clippy (release)" fail cargo clippy --locked --manifest-path $manifest --release --all-targets -- -D warnings
step "cargo test --lib" fail cargo test --locked --manifest-path $manifest --lib
step "cargo check (desktop)" fail cargo check --locked --manifest-path $manifest
if xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
  step "iOS compile" fail cargo check --locked --manifest-path $manifest --target aarch64-apple-ios --lib
else
  skip "iOS compile" "no iphoneos SDK (full Xcode is not installed)"
fi
if [ -n "$ndk_bin" ]; then
  step "Android compile" fail android_check
else
  skip "Android compile" "NDK $ndk_version not found under $sdk"
fi
step "npm audit" warn npm audit --audit-level=high
if command -v cargo-audit >/dev/null 2>&1; then
  step "cargo audit" warn bash -c 'cd src-tauri && cargo audit --db "$0"' "$advisory_db"
else
  skip "cargo audit" "cargo-audit is not installed"
fi

echo
printf '%-26s %7s  %s\n' step seconds result
total=0
for i in "${!names[@]}"; do
  printf '%-26s %7s  %s\n' "${names[$i]}" "${secs[$i]}" "${states[$i]}"
  total=$(( total + secs[i] ))
done
printf '%-26s %7s\n' total "$total"
exit "$failed"
