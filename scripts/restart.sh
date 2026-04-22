#!/usr/bin/env bash
# Delayed pm2 restart for PMAOS.
# Called as a detached process so the bot handler can finish and Grammy
# acknowledges the Telegram update before the process is killed.
#
# Usage (from the primary bot / Claude Code):
#   nohup bash /path/to/restart.sh ${BOT_NAME:-apex-bot} &>/dev/null &

BOT_NAME="${BOT_NAME:-apex-bot}"
APP_NAME="${1:-$BOT_NAME}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Snapshot current good state before restart (only for the primary bot)
if [ "$APP_NAME" = "$BOT_NAME" ] && [ -f "${SCRIPT_DIR}/snapshot.sh" ]; then
  bash "${SCRIPT_DIR}/snapshot.sh" 2>/dev/null || true
fi

sleep 3
pm2 restart "$APP_NAME" --update-env 2>/dev/null
