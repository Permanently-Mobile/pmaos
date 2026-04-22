#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# safe-mode.sh -- Restore the bot to last known good state
#
# Usage:
#   bash scripts/safe-mode.sh              # restore dist/ only
#   bash scripts/safe-mode.sh --restore-db # restore dist/ + database
#
# Flow:
#   1. Stop the primary bot
#   2. Save current (broken) state for forensics
#   3. Restore dist/ from last snapshot
#   4. Optionally restore DB
#   5. Restart the primary bot
#   6. Verify health
# ─────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SNAPSHOT_DIR="${PROJECT_DIR}/recovery/snapshots/latest"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
BROKEN_DIR="${PROJECT_DIR}/recovery/snapshots/broken-${TIMESTAMP}"
RESTORE_DB=false
BOT_NAME="${BOT_NAME:-apex-bot}"

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --restore-db) RESTORE_DB=true ;;
  esac
done

# ── Colors ──────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}=== SAFE MODE RESTORE ===${NC}"
echo "Timestamp: ${TIMESTAMP}"
echo "Restore DB: ${RESTORE_DB}"
echo ""

# ── Verify snapshot exists ──────────────────────
if [ ! -d "${SNAPSHOT_DIR}/dist" ]; then
  echo -e "${RED}ERROR: No snapshot found at ${SNAPSHOT_DIR}/dist${NC}"
  echo "Cannot restore. Try Step 8 (Full Rebuild from Git) in the recovery CLAUDE.md."
  exit 1
fi

echo "Snapshot found: $(cat "${SNAPSHOT_DIR}/timestamp.txt" 2>/dev/null || echo "unknown")"
echo "Commit: $(cat "${SNAPSHOT_DIR}/commit-hash.txt" 2>/dev/null || echo "unknown")"
echo ""

# ── 1. Stop the primary bot ────────────────────────────────
echo -e "${YELLOW}[1/6] Stopping ${BOT_NAME}...${NC}"
pm2 stop "${BOT_NAME}" 2>/dev/null || echo "  (was not running)"
sleep 2

# ── 2. Save broken state for forensics ──────────
echo -e "${YELLOW}[2/6] Saving broken state for forensics...${NC}"
mkdir -p "$BROKEN_DIR"

# Save current dist/
if [ -d "${PROJECT_DIR}/dist" ]; then
  cp -r "${PROJECT_DIR}/dist" "${BROKEN_DIR}/dist"
fi

# Save current DB
if [ -f "${PROJECT_DIR}/store/apex.db" ]; then
  cp "${PROJECT_DIR}/store/apex.db" "${BROKEN_DIR}/apex.db"
  [ -f "${PROJECT_DIR}/store/apex.db-wal" ] && \
    cp "${PROJECT_DIR}/store/apex.db-wal" "${BROKEN_DIR}/apex.db-wal" || true
fi

# Save recent logs
pm2 logs "${BOT_NAME}" --lines 500 --nostream > "${BROKEN_DIR}/pm2-logs.txt" 2>&1 || true

# Save git diff (what changed since last good state)
cd "$PROJECT_DIR"
GOOD_COMMIT=$(cat "${SNAPSHOT_DIR}/commit-hash.txt" 2>/dev/null || echo "")
if [ -n "$GOOD_COMMIT" ]; then
  git log --oneline "${GOOD_COMMIT}..HEAD" > "${BROKEN_DIR}/change-log.txt" 2>/dev/null || true
  git diff "${GOOD_COMMIT}" > "${BROKEN_DIR}/code-diff.txt" 2>/dev/null || true
fi

echo "  Saved to: ${BROKEN_DIR}"

# ── 3. Restore dist/ ────────────────────────────
echo -e "${YELLOW}[3/6] Restoring dist/ from snapshot...${NC}"
rm -rf "${PROJECT_DIR}/dist"
cp -r "${SNAPSHOT_DIR}/dist" "${PROJECT_DIR}/dist"
echo "  dist/ restored"

# ── 4. Restore DB (optional) ────────────────────
if [ "$RESTORE_DB" = true ]; then
  echo -e "${YELLOW}[4/6] Restoring database from snapshot...${NC}"
  if [ -f "${SNAPSHOT_DIR}/apex.db" ]; then
    cp "${SNAPSHOT_DIR}/apex.db" "${PROJECT_DIR}/store/apex.db"
    [ -f "${SNAPSHOT_DIR}/apex.db-wal" ] && \
      cp "${SNAPSHOT_DIR}/apex.db-wal" "${PROJECT_DIR}/store/apex.db-wal" || true
    [ -f "${SNAPSHOT_DIR}/apex.db-shm" ] && \
      cp "${SNAPSHOT_DIR}/apex.db-shm" "${PROJECT_DIR}/store/apex.db-shm" || true
    echo "  Database restored"
  else
    echo -e "${RED}  No DB in snapshot. Skipping.${NC}"
  fi
else
  echo -e "${YELLOW}[4/6] Skipping DB restore (use --restore-db to include)${NC}"
fi

# ── 5. Restart the primary bot ─────────────────────────────
echo -e "${YELLOW}[5/6] Starting ${BOT_NAME}...${NC}"
cd "$PROJECT_DIR"
pm2 start ecosystem.config.cjs --only "${BOT_NAME}"
sleep 5

# ── 6. Health check ──────────────────────────────
echo -e "${YELLOW}[6/6] Health check...${NC}"
STATUS=$(pm2 jlist 2>/dev/null | BOT_NAME="${BOT_NAME}" node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const apps=JSON.parse(d);
      const bot=apps.find(a=>a.name===process.env.BOT_NAME);
      console.log(bot ? bot.pm2_env.status : 'not_found');
    } catch(e) { console.log('parse_error'); }
  });
" 2>/dev/null || echo "check_failed")

if [ "$STATUS" = "online" ]; then
  echo -e "${GREEN}=== SAFE MODE COMPLETE ===${NC}"
  echo "${BOT_NAME} is ONLINE."
  echo ""
  echo "Broken state saved to: ${BROKEN_DIR}"
  echo "  - pm2-logs.txt     (last 500 log lines)"
  echo "  - change-log.txt   (git commits since last good state)"
  echo "  - code-diff.txt    (code changes since last good state)"
  echo "  - dist/            (the broken compiled code)"
  echo ""
  echo "Share these with the operator for investigation."
else
  echo -e "${RED}=== SAFE MODE FAILED ===${NC}"
  echo "${BOT_NAME} status: ${STATUS}"
  echo "Try Step 8 (Full Rebuild from Git) in recovery/CLAUDE.md."
fi
