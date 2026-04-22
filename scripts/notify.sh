#!/bin/bash
# Send a Telegram message mid-task.
# Usage: notify.sh "message text"              -- sends to personal chat
#        notify.sh "message text" --workflow    -- sends to workflow group
# Reads TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID, WORKFLOW_CHAT_ID from .env or .env.age.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."
ENV_FILE="$PROJECT_DIR/.env"
AGE_FILE="$PROJECT_DIR/.env.age"

# Try to decrypt .env.age if plaintext .env doesn't exist
if [ ! -f "$ENV_FILE" ] && [ -f "$AGE_FILE" ]; then
  AGE_KEY="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
  if [ -f "$AGE_KEY" ]; then
    # Find age binary
    AGE_BIN=$(command -v age 2>/dev/null)
    if [ -z "$AGE_BIN" ]; then
      # Check winget install location
      AGE_BIN=$(find "$LOCALAPPDATA/Microsoft/WinGet/Packages" -name "age.exe" 2>/dev/null | head -1)
    fi
    if [ -n "$AGE_BIN" ]; then
      ENV_CONTENT=$("$AGE_BIN" -d -i "$AGE_KEY" "$AGE_FILE" 2>/dev/null)
      if [ $? -eq 0 ]; then
        TOKEN=$(echo "$ENV_CONTENT" | grep -E '^TELEGRAM_BOT_TOKEN=' | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        CHAT_ID=$(echo "$ENV_CONTENT" | grep -E '^ALLOWED_CHAT_ID=' | cut -d'=' -f2- | tr -d '"' | tr -d "'")
        WORKFLOW_ID=$(echo "$ENV_CONTENT" | grep -E '^WORKFLOW_CHAT_ID=' | cut -d'=' -f2- | tr -d '"' | tr -d "'")
      fi
    fi
  fi
else
  # Plaintext .env fallback
  TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  CHAT_ID=$(grep -E '^ALLOWED_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  WORKFLOW_ID=$(grep -E '^WORKFLOW_CHAT_ID=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "$TOKEN" ] || [ -z "$CHAT_ID" ]; then
  echo "notify.sh: TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID not available" >&2
  exit 1
fi

# Route to workflow group if --workflow flag is passed
TARGET="$CHAT_ID"
if [ "$2" = "--workflow" ] && [ -n "$WORKFLOW_ID" ]; then
  TARGET="$WORKFLOW_ID"
fi

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  -d chat_id="${TARGET}" \
  -d text="${1}" \
  -d parse_mode="HTML" > /dev/null
