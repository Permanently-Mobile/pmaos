#!/bin/bash
# ── Decrypt bot .env.age files for Docker mount ──────────────
# Run before: docker compose -f docker/crypto-bots.yml up
# Decrypts each bot's .env.age to plaintext .env
# ──────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
AGE_KEY="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

if [ ! -f "$AGE_KEY" ]; then
  echo "[decrypt] ERROR: Age key not found at $AGE_KEY"
  exit 1
fi

# Find age binary
AGE_BIN=""
if command -v age &>/dev/null; then
  AGE_BIN="age"
else
  # Windows winget location
  WINGET_DIR="$LOCALAPPDATA/Microsoft/WinGet/Packages"
  if [ -d "$WINGET_DIR" ]; then
    AGE_BIN=$(find "$WINGET_DIR" -name "age.exe" -path "*/FiloSottile*" 2>/dev/null | head -1)
  fi
fi

if [ -z "$AGE_BIN" ]; then
  echo "[decrypt] ERROR: age binary not found"
  exit 1
fi

# Decrypt specified bots (default: all bots with .env.age files)
BOTS="${@}"

for bot in $BOTS; do
  AGE_FILE="$ROOT/bots/$bot/.env.age"
  ENV_FILE="$ROOT/bots/$bot/.env"

  if [ ! -f "$AGE_FILE" ]; then
    echo "[decrypt] SKIP: $AGE_FILE not found"
    continue
  fi

  "$AGE_BIN" -d -i "$AGE_KEY" "$AGE_FILE" > "$ENV_FILE"
  echo "[decrypt] OK: $bot (.env.age -> .env)"
done

echo "[decrypt] Done. Ready for docker compose up."
