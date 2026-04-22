#!/usr/bin/env bash
# ============================================================================
# apex-vault.sh -- Emergency vault file access (no AI required)
# Part of Layer 1: Provider-Independent Emergency CLI Toolkit
# ============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
VAULT="${VAULT_ROOT:-}"

# -- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# -- Helpers -----------------------------------------------------------------
print_header() {
    echo -e "${BOLD}${CYAN}=== APEX VAULT ===${NC}"
    echo ""
}

check_vault() {
    if [ ! -d "$VAULT" ]; then
        echo -e "${RED}Vault not found at $VAULT${NC}"
        exit 1
    fi
}

# -- Commands ----------------------------------------------------------------

cmd_read() {
    local rel_path="$1"
    local full_path="$VAULT/$rel_path"

    check_vault

    if [ ! -f "$full_path" ]; then
        echo -e "${RED}File not found: $rel_path${NC}"
        echo -e "${DIM}Full path: $full_path${NC}"
        exit 1
    fi

    print_header
    echo -e "${DIM}File: $rel_path${NC}"
    echo -e "${DIM}$(wc -l < "$full_path") lines${NC}"
    echo "---"
    cat "$full_path"
}

cmd_search() {
    local keyword="$1"

    check_vault
    print_header
    echo -e "Searching vault for: ${BOLD}$keyword${NC}"
    echo ""

    local results
    results=$(grep -rn --include="*.md" -i "$keyword" "$VAULT" 2>/dev/null || true)

    if [ -z "$results" ]; then
        echo -e "${DIM}No results for '$keyword'.${NC}"
        return
    fi

    local count
    count=$(echo "$results" | wc -l)
    echo -e "${GREEN}$count matches${NC}"
    echo ""

    # Group by file
    local current_file=""
    echo "$results" | while IFS= read -r line; do
        local file_path line_num content
        file_path=$(echo "$line" | cut -d: -f1)
        line_num=$(echo "$line" | cut -d: -f2)
        content=$(echo "$line" | cut -d: -f3-)

        # Make path relative
        local rel_path="${file_path#$VAULT/}"

        if [ "$file_path" != "$current_file" ]; then
            current_file="$file_path"
            echo -e "\n${BOLD}${CYAN}$rel_path${NC}"
        fi

        echo -e "  ${DIM}L$line_num:${NC} $content"
    done
}

cmd_recent() {
    check_vault
    print_header
    echo -e "Files modified in the last 24 hours:"
    echo ""

    local results
    # Use find with -mmin for cross-platform compat (1440 min = 24h)
    results=$(find "$VAULT" -name "*.md" -mmin -1440 -not -path "*/.git/*" -type f 2>/dev/null | sort || true)

    if [ -z "$results" ]; then
        echo -e "${DIM}No files modified in the last 24 hours.${NC}"
        return
    fi

    echo "$results" | while IFS= read -r file; do
        local rel_path="${file#$VAULT/}"
        local mod_time
        # stat format differs between GNU and BSD -- try both
        mod_time=$(stat -c '%Y' "$file" 2>/dev/null || stat -f '%m' "$file" 2>/dev/null || echo "0")
        local human_time
        if command -v date >/dev/null 2>&1; then
            # Try GNU date first, then BSD
            human_time=$(date -d "@$mod_time" '+%H:%M' 2>/dev/null || date -r "$mod_time" '+%H:%M' 2>/dev/null || echo "??:??")
        else
            human_time="??:??"
        fi
        echo -e "  ${DIM}$human_time${NC}  ${GREEN}$rel_path${NC}"
    done
}

cmd_daily() {
    check_vault

    local today
    today=$(date '+%Y-%m-%d')
    local daily_dir="$VAULT/Daily Notes"
    local daily_file="$daily_dir/$today.md"

    print_header

    if [ -f "$daily_file" ]; then
        echo -e "${GREEN}Today's daily note ($today):${NC}"
        echo "---"
        cat "$daily_file"
    else
        echo -e "${YELLOW}No daily note for $today. Creating...${NC}"

        mkdir -p "$daily_dir"
        cat > "$daily_file" << EOF
---
type: daily-note
date: $today
---

## Tasks


## Notes


## Log

EOF
        echo -e "${GREEN}Created: Daily Notes/$today.md${NC}"
        echo "---"
        cat "$daily_file"

        # Auto-commit
        cd "$VAULT" || exit 1
        if ! (git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]); then
            git add -A
            git commit -m "[emergency-cli] created daily note $today" --quiet 2>/dev/null
            echo -e "\n${DIM}Vault committed.${NC}"
        fi
    fi
}

cmd_edit() {
    local rel_path="$1"
    local full_path="$VAULT/$rel_path"

    check_vault

    if [ ! -f "$full_path" ]; then
        echo -e "${RED}File not found: $rel_path${NC}"
        exit 1
    fi

    # Use EDITOR env var, fall back to common editors
    local editor="${EDITOR:-}"
    if [ -z "$editor" ]; then
        if command -v nano >/dev/null 2>&1; then
            editor="nano"
        elif command -v vim >/dev/null 2>&1; then
            editor="vim"
        elif command -v vi >/dev/null 2>&1; then
            editor="vi"
        elif command -v notepad >/dev/null 2>&1; then
            editor="notepad"
        else
            echo -e "${RED}No editor found. Set EDITOR env var.${NC}"
            exit 1
        fi
    fi

    echo -e "${DIM}Opening $rel_path in $editor...${NC}"
    $editor "$full_path"

    # Auto-commit after edit
    cd "$VAULT" || exit 1
    if ! (git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]); then
        git add -A
        git commit -m "[emergency-cli] edited $rel_path" --quiet 2>/dev/null
        echo -e "${GREEN}Vault committed.${NC}"
    else
        echo -e "${DIM}No changes detected.${NC}"
    fi
}

# -- Help --------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}apex-vault.sh${NC} -- Emergency vault file access (no AI)"
    echo ""
    echo -e "${BOLD}USAGE:${NC}"
    echo "  apex-vault.sh read <relative-path>    Read a vault file"
    echo "  apex-vault.sh search <keyword>        Search across the vault"
    echo "  apex-vault.sh recent                  Files modified in last 24h"
    echo "  apex-vault.sh daily                   Show/create today's daily note"
    echo "  apex-vault.sh edit <relative-path>    Open file in default editor"
    echo "  apex-vault.sh --help                  Show this help"
    echo ""
    echo -e "${BOLD}EXAMPLES:${NC}"
    echo "  apex-vault.sh read Tasks.md"
    echo "  apex-vault.sh read \"Projects/Example/Example.md\""
    echo "  apex-vault.sh search \"pfSense\""
    echo "  apex-vault.sh recent"
    echo "  apex-vault.sh daily"
    echo "  apex-vault.sh edit \"Notes/my-note.md\""
    echo ""
    echo -e "${DIM}Vault: $VAULT${NC}"
    echo -e "${DIM}Auto-commits after edits.${NC}"
}

# -- Main --------------------------------------------------------------------
case "${1:---help}" in
    read)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-vault.sh read <relative-path>${NC}"
            exit 1
        fi
        cmd_read "$2"
        ;;
    search)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-vault.sh search <keyword>${NC}"
            exit 1
        fi
        cmd_search "$2"
        ;;
    recent)
        cmd_recent
        ;;
    daily)
        cmd_daily
        ;;
    edit)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-vault.sh edit <relative-path>${NC}"
            exit 1
        fi
        cmd_edit "$2"
        ;;
    --help|-h|help)
        cmd_help
        ;;
    *)
        echo -e "${RED}Unknown command: $1${NC}"
        cmd_help
        exit 1
        ;;
esac
