#!/usr/bin/env bash
# Uninstalls AI Usage Tracker on macOS, purging application data, preferences,
# temporary login profiles, and saved generic credentials from the Apple Keychain.
set -euo pipefail

BUNDLE_ID="com.dubba.ai.usage.tracker"
APP_NAME="AI Usage Tracker"
SERVICES=("ai-usage-tracker" "paseo-usage-bridge")
TEMP_PREFIXES=("ai-usage-grok-" "ai-usage-oauth-" "ai-usage-opencode-")

DRY_RUN=0
CONFIRM=1
REMOVE_APP=0
APP_PATH="/Applications/${APP_NAME}.app"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -y|--yes|--force)
      CONFIRM=0
      shift
      ;;
    --remove-app)
      REMOVE_APP=1
      shift
      ;;
    --app-path)
      APP_PATH="$2"
      REMOVE_APP=1
      shift 2
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [options]"
      echo ""
      echo "Options:"
      echo "  --dry-run          Print what would be removed without deleting anything"
      echo "  -y, --yes, --force Run non-interactively without prompting"
      echo "  --remove-app       Also delete ${APP_NAME}.app from /Applications"
      echo "  --app-path <path>  Specify a custom path to ${APP_NAME}.app to remove"
      echo "  -h, --help         Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$CONFIRM" -eq 1 ]]; then
  echo "This will permanently delete all local accounts, settings, temporary profiles,"
  echo "and Apple Keychain credentials for ${APP_NAME} (${BUNDLE_ID})."
  if [[ "$REMOVE_APP" -eq 1 ]]; then
    echo "It will also delete the application bundle at: ${APP_PATH}"
  fi
  read -r -p "Are you sure you want to proceed? [y/N] " response
  case "$response" in
    [yY][eE][sS]|[yY])
      ;;
    *)
      echo "Uninstallation cancelled."
      exit 0
      ;;
  esac
fi

echo "==> Uninstalling ${APP_NAME}..."

# 1. Terminate running instance if any
if pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Would terminate running process: ${APP_NAME}"
  else
    echo "--> Terminating running ${APP_NAME} process..."
    killall "${APP_NAME}" 2>/dev/null || true
    sleep 0.5
  fi
fi

# 2. Purge Keychain generic passwords
for service in "${SERVICES[@]}"; do
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Would delete Keychain credentials with service: ${service}"
  else
    echo "--> Removing Keychain credentials for service '${service}'..."
    count=0
    while security delete-generic-password -s "${service}" >/dev/null 2>&1; do
      count=$((count + 1))
    done
    if [[ "$count" -gt 0 ]]; then
      echo "    Removed ${count} Keychain entry(ies) for '${service}'."
    fi
  fi
done

# 3. Remove application directories in ~/Library
DATA_DIRS=(
  "$HOME/Library/Application Support/${BUNDLE_ID}"
  "$HOME/Library/Caches/${BUNDLE_ID}"
  "$HOME/Library/WebKit/${BUNDLE_ID}"
  "$HOME/Library/HTTPStorages/${BUNDLE_ID}"
  "$HOME/Library/Saved Application State/${BUNDLE_ID}.savedState"
  "$HOME/Library/Preferences/${BUNDLE_ID}.plist"
)

for target in "${DATA_DIRS[@]}"; do
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] Would remove: ${target}"
    else
      echo "--> Removing ${target}..."
      rm -rf "$target"
    fi
  fi
done

# 4. Clear UserDefaults preferences cache
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] Would reset preferences domain: ${BUNDLE_ID}"
else
  defaults delete "${BUNDLE_ID}" 2>/dev/null || true
fi

# 5. Clean temporary login profiles from $TMPDIR
TEMP_DIR="${TMPDIR:-/tmp}"
if [[ -d "$TEMP_DIR" ]]; then
  for prefix in "${TEMP_PREFIXES[@]}"; do
    for dir in "${TEMP_DIR%/}/${prefix}"*; do
      if [[ -d "$dir" ]]; then
        # Ensure name doesn't contain path traversal
        base_name="$(basename "$dir")"
        if [[ "$base_name" =~ ^${prefix}[A-Za-z0-9-]+$ ]]; then
          if [[ "$DRY_RUN" -eq 1 ]]; then
            echo "[dry-run] Would remove temporary profile: ${dir}"
          else
            echo "--> Removing temporary login profile: ${dir}..."
            rm -rf "$dir"
          fi
        fi
      fi
    done
  done
fi

# 6. Optionally remove the .app bundle
if [[ "$REMOVE_APP" -eq 1 ]]; then
  if [[ -d "$APP_PATH" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "[dry-run] Would remove application bundle: ${APP_PATH}"
    else
      echo "--> Removing application bundle at ${APP_PATH}..."
      rm -rf "$APP_PATH"
    fi
  fi
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> Dry run complete. No files were modified."
else
  echo "==> ${APP_NAME} uninstalled successfully. All data and credentials cleared."
fi
