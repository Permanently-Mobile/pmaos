#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# scan-skill.sh
# Pre-install security scan for Claude Code skills
# Uses Cisco AI Defense Skill Scanner (local, no API keys)
# Must pass before any skill is installed.
# ─────────────────────────────────────────────────
#
# Usage:
#   scan-skill.sh /path/to/skill-folder
#   scan-skill.sh /path/to/skill-folder --install
#     (auto-copies to ~/.claude/skills/ if scan passes)
#
# ─────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY="$SCRIPT_DIR/notify.sh"
SKILLS_DIR="$HOME/.claude/skills"
QUARANTINE_DIR="$SCRIPT_DIR/../store/quarantine"
SCAN_LOG_DIR="$SCRIPT_DIR/../store/skill-scans"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Args ────────────────────────────────────────
SKILL_PATH="${1:-}"
AUTO_INSTALL=false

if [ -z "$SKILL_PATH" ]; then
  echo "Usage: scan-skill.sh /path/to/skill [--install]"
  exit 1
fi

if [ "${2:-}" = "--install" ]; then
  AUTO_INSTALL=true
fi

SKILL_NAME=$(basename "$SKILL_PATH")

mkdir -p "$QUARANTINE_DIR" "$SCAN_LOG_DIR"

echo -e "${YELLOW}Scanning skill: ${SKILL_NAME}${NC}"
echo "Path: $SKILL_PATH"
echo ""

# ── Step 1: Copy to quarantine first ────────────
echo -e "${YELLOW}[1/3] Quarantining skill...${NC}"
QUARANTINE_PATH="$QUARANTINE_DIR/${SKILL_NAME}-${TIMESTAMP}"
cp -r "$SKILL_PATH" "$QUARANTINE_PATH"
echo "  Copied to: $QUARANTINE_PATH"

# ── Step 2: Full scan (static + behavioral + trigger) ──
echo -e "${YELLOW}[2/3] Running all local analyzers...${NC}"
SCAN_REPORT="$SCAN_LOG_DIR/${SKILL_NAME}-${TIMESTAMP}.txt"

SCAN_OUTPUT=$(skill-scanner scan "$QUARANTINE_PATH" --use-behavioral --use-trigger --format markdown 2>&1) || true
echo "$SCAN_OUTPUT" > "$SCAN_REPORT"

# Parse findings from the summary section (e.g. "- **Critical:** 1")
CRITICAL_COUNT=$(echo "$SCAN_OUTPUT" | grep -oP '\*\*Critical:\*\* \K[0-9]+' || echo "0")
HIGH_COUNT=$(echo "$SCAN_OUTPUT" | grep -oP '\*\*High:\*\* \K[0-9]+' || echo "0")
MEDIUM_COUNT=$(echo "$SCAN_OUTPUT" | grep -oP '\*\*Medium:\*\* \K[0-9]+' || echo "0")

# Fallback: check if scanner returned an error (skill not loadable)
if echo "$SCAN_OUTPUT" | grep -qi "error loading skill"; then
  echo -e "${RED}  Scanner error -- skill format invalid or SKILL.md missing${NC}"
  echo "  Output: $(echo "$SCAN_OUTPUT" | head -3)"
  echo ""
  echo "  Skill must have a SKILL.md with frontmatter (name, description, version)."
  echo "  Quarantined at: $QUARANTINE_PATH"
  exit 1
fi

echo "  Critical: $CRITICAL_COUNT"
echo "  High: $HIGH_COUNT"
echo "  Medium: $MEDIUM_COUNT"

# ── Step 3: Verdict ────────────────────────────
echo ""
echo -e "${YELLOW}[3/3] Verdict...${NC}"

if [ "$CRITICAL_COUNT" -gt 0 ]; then
  echo -e "${RED}BLOCKED -- $CRITICAL_COUNT critical finding(s)${NC}"
  echo ""
  echo "Skill quarantined at: $QUARANTINE_PATH"
  echo "Full report: $SCAN_REPORT"

  bash "$NOTIFY" "$(echo -e "🔴 Skill BLOCKED: ${SKILL_NAME}\n\n${CRITICAL_COUNT} critical, ${HIGH_COUNT} high\n\nQuarantined. Review before manual install.")" 2>/dev/null || true

  echo ""
  echo "DO NOT install this skill. Review the report and quarantine."
  exit 1

elif [ "$HIGH_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}WARNING -- $HIGH_COUNT high-risk finding(s)${NC}"
  echo ""
  echo "Skill quarantined at: $QUARANTINE_PATH"
  echo "Full report: $SCAN_REPORT"

  bash "$NOTIFY" "$(echo -e "🟡 Skill WARNING: ${SKILL_NAME}\n\n${HIGH_COUNT} high finding(s)\nReview required before install.")" 2>/dev/null || true

  if [ "$AUTO_INSTALL" = true ]; then
    echo ""
    echo -e "${RED}Auto-install blocked due to high-risk findings.${NC}"
    echo "Review the report, then manually copy if approved:"
    echo "  cp -r \"$QUARANTINE_PATH\" \"$SKILLS_DIR/$SKILL_NAME\""
  fi
  exit 1

else
  echo -e "${GREEN}PASSED -- No critical or high-risk findings${NC}"
  echo "Full report: $SCAN_REPORT"

  if [ "$AUTO_INSTALL" = true ]; then
    echo ""
    echo "Installing to $SKILLS_DIR/$SKILL_NAME..."
    mkdir -p "$SKILLS_DIR"
    cp -r "$QUARANTINE_PATH" "$SKILLS_DIR/$SKILL_NAME"
    echo -e "${GREEN}Installed.${NC}"

    # Register in canary system for integrity monitoring
    echo "Registering in canary system..."
    node "$SCRIPT_DIR/../dist/skill-canary.js" register-one "$SKILL_NAME" 2>/dev/null || echo "  (canary registration skipped -- run 'node dist/skill-canary.js register' manually)"

    bash "$NOTIFY" "$(echo -e "🟢 Skill installed: ${SKILL_NAME}\n\nPassed all security scans.")" 2>/dev/null || true
  else
    echo ""
    echo "To install manually:"
    echo "  cp -r \"$QUARANTINE_PATH\" \"$SKILLS_DIR/$SKILL_NAME\""
  fi
  exit 0
fi
