#!/usr/bin/env bash
# Runs the checks CI's Validate workflow runs, against a clean checkout, so gitignored
# local files (generated Android Kotlin, icons, dist) cannot hide a failure.
# Windows tests are the only part of Validate this cannot reproduce.
#
#   npm run preflight                                  # everything, on HEAD
#   PREFLIGHT_CACHE_DIR=/some/dir npm run preflight    # separate cache root (cold-run timing)
#   bash scripts/preflight.sh --pre-push < refs        # what .githooks/pre-push runs
#   PREFLIGHT_DRY_RUN=1 ...                            # print what would run, then stop
#
# With --pre-push it reads git's pre-push lines from stdin, checks out the commit being
# pushed, and runs only the groups the push touches (Rust, frontend, scripts). It narrows
# only for a fast-forward of a single branch; anything else, or PREFLIGHT_FULL=1, runs
# everything. Branch deletes send no commits and are ignored, so a push of only deletes
# runs nothing. Paths that no check reads (Markdown, docs/, release-apks/,
# sidestore-source.json) select nothing, and any path not listed below selects everything.
#
# After `npm run build`, the npm tests and two Cargo tracks run at the same time. Cargo
# locks each profile and target directory separately, so the tracks share one warm
# CARGO_TARGET_DIR without waiting on each other. A third track measured no faster on a
# 10-core, 16 GB Mac. PREFLIGHT_CARGO_TRACKS=1 runs Cargo in sequence (for a loaded machine).
#
# Everything it writes (worktree, Cargo target, npm cache, advisory database) lives under
# PREFLIGHT_CACHE_DIR. It defaults to /Volumes/External/_caches when that drive is mounted,
# otherwise ~/.cache (about 6 GB of Cargo output fresh, more as old builds pile up). PREFLIGHT_ADVISORY_DB overrides the
# advisory database location the same way.
set -uo pipefail

repo=$(git rev-parse --show-toplevel)
is_sha() { [[ $1 =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]]; }

# Decide what to check: the commit (target) and the groups (rust, frontend, scripts).
target=HEAD
scope=full
why="manual run"
changed=""
if [ "${1:-}" = --pre-push ]; then
  why="push touches every group"
  count=0
  deletes=0
  while read -r _lref lsha _rref rsha; do
    [ -n "${lsha:-}" ] || continue
    # A delete sends no commits, so it needs no check and does not count as an update.
    if [[ $lsha =~ ^0+$ ]]; then
      deletes=$((deletes + 1))
      continue
    fi
    count=$((count + 1))
    push_local=$lsha
    push_remote=${rsha:-}
  done
  if [ "$count" -eq 0 ] && [ "$deletes" -gt 0 ]; then
    echo "preflight: only deletes ($deletes), nothing to check"
    exit 0
  elif [ "$count" -eq 0 ]; then
    why="no refs on stdin"
  elif [ "$count" -gt 1 ]; then
    why="push updates $count refs; checking HEAD only"
  elif ! is_sha "$push_local"; then
    why="unreadable push line"
  else
    target=$push_local
    if ! is_sha "$push_remote" || [[ $push_remote =~ ^0+$ ]]; then
      why="new branch"
    elif ! git merge-base --is-ancestor "$push_remote" "$push_local" 2>/dev/null; then
      why="not a fast-forward"
    else
      scope=push
      changed=$(git diff --name-only "$push_remote" "$push_local") || { scope=full; why="git diff failed"; }
    fi
  fi
fi
[ "${PREFLIGHT_FULL:-}" = 1 ] && { scope=full; why="PREFLIGHT_FULL=1"; }

rust=0 frontend=0 scripts=0
if [ "$scope" = full ]; then
  rust=1 frontend=1 scripts=1
else
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case $f in
      scripts/preflight.sh | .githooks/*) rust=1 frontend=1 scripts=1; why="$f changed" ;;
      .github/*) scripts=1 ;;
      src-tauri/*) rust=1 ;;
      src/* | public/* | index.html | vite.config.* | vitest.config.* | tsconfig*.json | .oxlintrc.json | package-lock.json) frontend=1 ;;
      package.json) frontend=1 scripts=1 ;;
      scripts/*) scripts=1 ;;
      docs/* | *.md | release-apks/* | sidestore-source.json) ;;
      *) rust=1 frontend=1 scripts=1; why="unclassified path $f" ;;
    esac
  done <<<"$changed"
  [ "$rust$frontend$scripts" = 111 ] && scope=full
fi
need_npm=$(( rust || frontend ))

groups=""
[ "$rust" = 1 ] && groups="$groups rust"
[ "$frontend" = 1 ] && groups="$groups frontend"
[ "$scripts" = 1 ] && groups="$groups scripts"
if [ "$scope" = full ]; then
  echo "preflight: full run of $target ($why)"
else
  echo "preflight: $target, push touches:${groups:- nothing that is checked}"
fi
if [ -z "$groups" ]; then
  echo "preflight: nothing to run"
  exit 0
fi
[ "${PREFLIGHT_DRY_RUN:-}" = 1 ] && exit 0

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
  local jobs_left
  jobs_left=$(jobs -p)
  [ -n "$jobs_left" ] && kill $jobs_left 2>/dev/null
  wait 2>/dev/null
  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run_start=$(date +%s)

# Each step leaves <id>.log, <id>.state, <id>.start, and <id>.secs under $logs, so steps
# can run in background tracks and the summary still lists them in a fixed order.
# step <id> <fail|warn> <command...>: runs in the worktree, keeps going on failure.
step() {
  local id=$1 kind=$2 start state
  shift 2
  start=$(date +%s)
  printf '==> %s\n' "$id"
  if (cd "$wt" 2>/dev/null || cd "$repo"; "$@") >"$logs/$id.log" 2>&1; then
    state=pass
  elif [ "$kind" = warn ]; then
    state=WARN
  else
    state=FAIL
  fi
  echo $((start - run_start)) >"$logs/$id.start"
  echo $(( $(date +%s) - start )) >"$logs/$id.secs"
  echo "$state" >"$logs/$id.state"
  printf '<== %s %s\n' "$id" "$state"
}

# skip <id> <reason>
skip() {
  echo "skip: $2" >"$logs/$1.state"
}

passed() { [ "$(cat "$logs/$1.state" 2>/dev/null)" = pass ]; }

ndk_bin=
for d in "$sdk"/ndk/"$ndk_version"/toolchains/llvm/prebuilt/*/bin; do
  [ -d "$d" ] && ndk_bin=$d && break
done

android_check() {
  CC_aarch64_linux_android="$ndk_bin/aarch64-linux-android24-clang" \
    AR_aarch64_linux_android="$ndk_bin/llvm-ar" \
    cargo check --locked --manifest-path $manifest --target aarch64-linux-android --lib
}

script_tests() {
  npm run test:resolve-version && npm run test:release-notes && npm run test:sidestore-source &&
    npm run test:updater-manifest && npm run test:gemini-quota-probe && npm run test:windows-uninstall &&
    npm run test:workflows
}

step "worktree" fail git -C "$repo" worktree add --detach "$wt" "$target"
[ -d "$wt" ] || { echo "could not create the worktree"; exit 1; }

no_rust="no Rust changes in push"
no_frontend="no frontend changes in push"

# Setup: npm ci, with the format check beside it (it needs neither node_modules nor dist).
if [ "$rust" = 1 ]; then
  step "cargo fmt --check" fail cargo fmt --manifest-path $manifest --check &
else
  skip "cargo fmt --check" "$no_rust"
fi
if [ "$need_npm" = 1 ]; then
  step "npm ci" fail npm ci
else
  skip "npm ci" "no Rust or frontend changes in push"
fi
wait

# check and build both run tsc -b on the same build info, so they stay in sequence.
if [ "$frontend" = 1 ]; then
  step "npm run check" fail npm run check
else
  skip "npm run check" "$no_frontend"
fi
if [ "$need_npm" = 1 ]; then
  step "npm run build" fail npm run build
else
  skip "npm run build" "no Rust or frontend changes in push"
fi

# Parallel phase: the npm track beside the Cargo tracks.
(
  if [ "$frontend" = 1 ]; then step "npm test" fail npm test; else skip "npm test" "$no_frontend"; fi
  if [ "$scripts" = 1 ]; then
    step "npm run test:* scripts" fail script_tests
  else
    skip "npm run test:* scripts" "no script or workflow changes in push"
  fi
  if [ "$need_npm" = 1 ]; then
    step "npm audit" warn npm audit --audit-level=high
  else
    skip "npm audit" "no Rust or frontend changes in push"
  fi
  if [ "$rust" != 1 ]; then
    skip "cargo audit" "$no_rust"
  elif command -v cargo-audit >/dev/null 2>&1; then
    step "cargo audit" warn bash -c 'cd src-tauri && cargo audit --db "$0"' "$advisory_db"
  else
    skip "cargo audit" "cargo-audit is not installed"
  fi
) &

cargo_ids=("cargo clippy (debug)" "cargo test --lib" "cargo clippy (release)" "iOS compile" "Android compile")
if [ "$rust" != 1 ]; then
  for id in "${cargo_ids[@]}"; do skip "$id" "$no_rust"; done
elif ! passed "npm run build"; then
  # tauri::generate_context! reads dist/ at compile time.
  for id in "${cargo_ids[@]}"; do skip "$id" "needs dist/, and npm run build failed"; done
else
  clippy_debug() { step "cargo clippy (debug)" fail cargo clippy --locked --manifest-path $manifest --all-targets -- -D warnings; }
  cargo_test() { step "cargo test --lib" fail cargo test --locked --manifest-path $manifest --lib; }
  clippy_release() { step "cargo clippy (release)" fail cargo clippy --locked --manifest-path $manifest --release --all-targets -- -D warnings; }
  ios() {
    if xcrun --sdk iphoneos --show-sdk-path >/dev/null 2>&1; then
      step "iOS compile" fail cargo check --locked --manifest-path $manifest --target aarch64-apple-ios --lib
    else
      skip "iOS compile" "no iphoneos SDK (full Xcode is not installed)"
    fi
  }
  android() {
    if [ -n "$ndk_bin" ]; then
      step "Android compile" fail android_check
    else
      skip "Android compile" "NDK $ndk_version not found under $sdk"
    fi
  }
  if [ "${PREFLIGHT_CARGO_TRACKS:-2}" = 1 ]; then
    clippy_debug; cargo_test; clippy_release; ios; android
  else
    { clippy_debug; cargo_test; } &
    { clippy_release; ios; android; } &
  fi
fi
wait

failed=0
order=("worktree" "npm ci" "cargo fmt --check" "npm run check" "npm run build" "npm test"
  "npm run test:* scripts" "${cargo_ids[@]}" "npm audit" "cargo audit")
for id in "${order[@]}"; do
  state=$(cat "$logs/$id.state" 2>/dev/null || echo "FAIL (no result)")
  case $state in
    FAIL* | WARN) printf '\n--- %s (last 25 lines) ---\n' "$id"; tail -n 25 "$logs/$id.log" 2>/dev/null ;;
  esac
  case $state in FAIL*) failed=1 ;; esac
done
echo
printf '%-26s %6s %8s  %s\n' step start seconds result
for id in "${order[@]}"; do
  state=$(cat "$logs/$id.state" 2>/dev/null || echo "FAIL (no result)")
  printf '%-26s %6s %8s  %s\n' "$id" "$(cat "$logs/$id.start" 2>/dev/null || echo -)" \
    "$(cat "$logs/$id.secs" 2>/dev/null || echo -)" "$state"
done
printf '%-26s %6s %8s\n' "wall clock" "" $(( $(date +%s) - run_start ))
exit "$failed"
