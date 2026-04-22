#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# snapshot.sh -- Save "last known good" state
# Called after every successful build + restart.
# Keeps only the latest snapshot (lightweight).
# ─────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SNAPSHOT_DIR="${PROJECT_DIR}/recovery/snapshots/latest"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")

# ── Create snapshot dir ──────────────────────────
mkdir -p "$SNAPSHOT_DIR"

# ── 1. Save git commit hash ─────────────────────
cd "$PROJECT_DIR"
git rev-parse HEAD > "${SNAPSHOT_DIR}/commit-hash.txt"
echo "$TIMESTAMP" > "${SNAPSHOT_DIR}/timestamp.txt"

# ── 2. Copy compiled dist/ ──────────────────────
# This is what actually runs. If we can restore this, the bot runs.
rm -rf "${SNAPSHOT_DIR}/dist"
cp -r "${PROJECT_DIR}/dist" "${SNAPSHOT_DIR}/dist"

# ── 3. Copy database ────────────────────────────
# Encrypted, but we back it up for safe mode restore.
if [ -f "${PROJECT_DIR}/store/apex.db" ]; then
  cp "${PROJECT_DIR}/store/apex.db" "${SNAPSHOT_DIR}/apex.db"
  [ -f "${PROJECT_DIR}/store/apex.db-wal" ] && \
    cp "${PROJECT_DIR}/store/apex.db-wal" "${SNAPSHOT_DIR}/apex.db-wal" || true
  [ -f "${PROJECT_DIR}/store/apex.db-shm" ] && \
    cp "${PROJECT_DIR}/store/apex.db-shm" "${SNAPSHOT_DIR}/apex.db-shm" || true
fi

# ── 4. Copy ecosystem config ────────────────────
cp "${PROJECT_DIR}/ecosystem.config.cjs" "${SNAPSHOT_DIR}/ecosystem.config.cjs"
cp "${PROJECT_DIR}/package.json" "${SNAPSHOT_DIR}/package.json"

# ── 5. Write manifest ───────────────────────────
cat > "${SNAPSHOT_DIR}/manifest.txt" <<EOF
Snapshot: ${TIMESTAMP}
Commit:   $(cat "${SNAPSHOT_DIR}/commit-hash.txt")
Node:     $(node --version 2>/dev/null || echo "unknown")
Files:    dist/ + apex.db + ecosystem.config.cjs + package.json
EOF

echo "Snapshot saved: ${SNAPSHOT_DIR} (${TIMESTAMP})"
