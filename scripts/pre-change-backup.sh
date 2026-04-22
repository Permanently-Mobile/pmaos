#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# pre-change-backup.sh
# Snapshots current state before major changes
# Backups saved to $BACKUP_ROOT (auto-detected per platform)
# ─────────────────────────────────────────────────

set -euo pipefail

# ── Config ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# Cross-platform: use env var, or default to project store/backups
BACKUP_ROOT="${BACKUP_ROOT:-${PROJECT_DIR}/store/backups/project-apex}"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
CHANGE_NAME="${1:-unnamed}"
BRANCH_NAME="backup/pre-${CHANGE_NAME}-${TIMESTAMP}"

# ── Colors ──────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Starting pre-change backup: ${CHANGE_NAME}${NC}"
echo "Timestamp: ${TIMESTAMP}"
echo ""

# ── Create backup dirs if needed ────────────────
mkdir -p "${BACKUP_ROOT}/git-snapshots"
mkdir -p "${BACKUP_ROOT}/databases"
mkdir -p "${BACKUP_ROOT}/configs"

# ── 1. Git: Create backup branch + tag ─────────
echo -e "${YELLOW}[1/4] Git snapshot...${NC}"
cd "$PROJECT_DIR"

# Stash any uncommitted work so it's not lost
STASH_RESULT=$(git stash push -m "pre-backup-stash-${TIMESTAMP}" 2>&1 || true)

# Create backup branch from current state
git branch "$BRANCH_NAME" 2>/dev/null && \
  echo "  Created branch: $BRANCH_NAME" || \
  echo "  Branch already exists, skipping"

# Tag it for easy reference
TAG_NAME="pre-${CHANGE_NAME}-${TIMESTAMP}"
git tag -a "$TAG_NAME" -m "Backup before: ${CHANGE_NAME}" 2>/dev/null && \
  echo "  Created tag: $TAG_NAME" || \
  echo "  Tag already exists, skipping"

# Restore stashed work if we stashed anything
if [[ "$STASH_RESULT" != *"No local changes"* ]]; then
  git stash pop --quiet 2>/dev/null || true
  echo "  Restored working changes from stash"
fi

# ── 2. Database backup ─────────────────────────
echo -e "${YELLOW}[2/4] Database backup...${NC}"
DB_SOURCE="${PROJECT_DIR}/store/apex.db"
DB_DEST="${BACKUP_ROOT}/databases/apex-${TIMESTAMP}.db"

if [ -f "$DB_SOURCE" ]; then
  cp "$DB_SOURCE" "$DB_DEST"
  # Also grab WAL and SHM if they exist for a complete backup
  [ -f "${DB_SOURCE}-wal" ] && cp "${DB_SOURCE}-wal" "${DB_DEST}-wal"
  [ -f "${DB_SOURCE}-shm" ] && cp "${DB_SOURCE}-shm" "${DB_DEST}-shm"
  echo "  Saved: $DB_DEST"
else
  echo "  No database found at $DB_SOURCE, skipping"
fi

# ── 3. Config/env backup ───────────────────────
echo -e "${YELLOW}[3/4] Config backup...${NC}"
CONFIG_DIR="${BACKUP_ROOT}/configs/${TIMESTAMP}"
mkdir -p "$CONFIG_DIR"

# Back up key config files
for f in .env ecosystem.config.cjs package.json CLAUDE.md; do
  if [ -f "${PROJECT_DIR}/${f}" ]; then
    cp "${PROJECT_DIR}/${f}" "${CONFIG_DIR}/${f}"
    echo "  Saved: ${f}"
  fi
done

# ── 4. Full project snapshot ─────────────────────
echo -e "${YELLOW}[4/4] Full project snapshot...${NC}"
SNAPSHOT_DIR="${BACKUP_ROOT}/git-snapshots/${TIMESTAMP}-${CHANGE_NAME}"
mkdir -p "$SNAPSHOT_DIR"

# Use tar to copy with exclusions (avoids copying node_modules, models, large cold storage)
tar -cf - \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='store/models' \
  --exclude='store/quarantine' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  -C "$PROJECT_DIR" . | tar -xf - -C "$SNAPSHOT_DIR"

echo "  Saved: $SNAPSHOT_DIR"

# ── Summary ─────────────────────────────────────
echo ""
echo -e "${GREEN}Backup complete.${NC}"
echo "─────────────────────────────────────────"
echo "  Git branch : $BRANCH_NAME (local only)"
echo "  Git tag    : $TAG_NAME (local only)"
echo "  DB backup  : $DB_DEST"
echo "  Configs    : $CONFIG_DIR"
echo "  Full copy  : $SNAPSHOT_DIR"
echo "─────────────────────────────────────────"

# ── Cleanup old backups (keep last 10) ──────────
echo ""
echo -e "${YELLOW}Checking old backups...${NC}"
SNAPSHOT_COUNT=$(ls -d "${BACKUP_ROOT}/git-snapshots/"*/ 2>/dev/null | wc -l)
DB_COUNT=$(ls "${BACKUP_ROOT}/databases/"*.db 2>/dev/null | wc -l)

if [ "$SNAPSHOT_COUNT" -gt 10 ]; then
  echo "  You have ${SNAPSHOT_COUNT} snapshots. Consider pruning old ones."
  echo "  Oldest: $(ls -d "${BACKUP_ROOT}/git-snapshots/"*/ | head -1)"
fi

if [ "$DB_COUNT" -gt 10 ]; then
  echo "  You have ${DB_COUNT} DB backups. Consider pruning old ones."
fi

echo ""
echo "Ready to make changes."
