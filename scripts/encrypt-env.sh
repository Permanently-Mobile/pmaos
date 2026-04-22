#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# encrypt-env.sh -- Encrypt all .env files with age
#
# Usage:
#   bash scripts/encrypt-env.sh          # encrypt + keep plaintext backup
#   bash scripts/encrypt-env.sh --purge  # encrypt + delete plaintext
#
# Requires: age binary, age keypair at ~/.config/sops/age/keys.txt
# ─────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
PURGE=false

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
  esac
done

# Find age binary
AGE_BIN=""
if command -v age &>/dev/null; then
  AGE_BIN="age"
else
  # Winget install location
  WINGET_AGE=$(find "$LOCALAPPDATA/Microsoft/WinGet/Packages" -name "age.exe" -path "*FiloSottile*" 2>/dev/null | head -1)
  if [ -n "$WINGET_AGE" ]; then
    AGE_BIN="$WINGET_AGE"
  fi
fi

if [ -z "$AGE_BIN" ]; then
  echo "ERROR: age binary not found. Install with: winget install FiloSottile.age"
  exit 1
fi

# Extract public key from the key file
PUB_KEY=$(grep "public key:" "$AGE_KEY_FILE" | awk '{print $NF}')
if [ -z "$PUB_KEY" ]; then
  echo "ERROR: Could not extract public key from $AGE_KEY_FILE"
  exit 1
fi

echo "Using age binary: $AGE_BIN"
echo "Public key: $PUB_KEY"
echo "Purge plaintext: $PURGE"
echo ""

# Find all .env files (main + bots)
ENV_FILES=(
  "$PROJECT_DIR/.env"
)

for bot_env in "$PROJECT_DIR"/bots/*/.env; do
  [ -f "$bot_env" ] && ENV_FILES+=("$bot_env")
done

echo "Found ${#ENV_FILES[@]} .env files to encrypt:"
for f in "${ENV_FILES[@]}"; do
  echo "  $f"
done
echo ""

# Encrypt each file
ENCRYPTED=0
SKIPPED=0

for env_file in "${ENV_FILES[@]}"; do
  age_file="${env_file}.age"

  # Skip if already encrypted and plaintext doesn't exist
  if [ -f "$age_file" ] && [ ! -f "$env_file" ]; then
    echo "SKIP: $env_file (already encrypted, no plaintext)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ ! -f "$env_file" ]; then
    echo "SKIP: $env_file (file not found)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Encrypt
  "$AGE_BIN" -e -r "$PUB_KEY" "$env_file" > "$age_file" 2>&1

  # Verify round-trip
  DECRYPTED=$("$AGE_BIN" -d -i "$AGE_KEY_FILE" "$age_file" 2>&1)
  ORIGINAL=$(cat "$env_file")

  if [ "$DECRYPTED" = "$ORIGINAL" ]; then
    echo "OK:   $env_file -> $age_file"
    ENCRYPTED=$((ENCRYPTED + 1))

    if [ "$PURGE" = true ]; then
      rm "$env_file"
      echo "      (plaintext deleted)"
    fi
  else
    echo "FAIL: $env_file (round-trip mismatch, keeping plaintext)"
    rm -f "$age_file"
  fi
done

echo ""
echo "Done: $ENCRYPTED encrypted, $SKIPPED skipped"

if [ "$PURGE" = true ]; then
  echo ""
  echo "Plaintext .env files have been deleted."
  echo "To decrypt: age -d -i ~/.config/sops/age/keys.txt <file>.env.age"
fi
