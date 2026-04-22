#!/usr/bin/env bash
# ============================================================================
# apex-tasks.sh -- Emergency vault task management (no AI required)
# Part of Layer 1: Provider-Independent Emergency CLI Toolkit
# ============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
VAULT="${VAULT_ROOT:-}"
TASKS_FILE="$VAULT/Tasks.md"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# -- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# -- Helpers -----------------------------------------------------------------
vault_commit() {
    local msg="$1"
    cd "$VAULT" || return 1
    if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
        return 0
    fi
    git add -A
    git commit -m "[emergency-cli] $msg" --quiet 2>/dev/null
}

print_header() {
    echo -e "${BOLD}${CYAN}=== APEX TASKS ===${NC}"
    echo ""
}

count_tasks() {
    local total open done
    total=$(grep -c '^\- \[[ x]\]' "$TASKS_FILE" 2>/dev/null || echo 0)
    open=$(grep -c '^\- \[ \]' "$TASKS_FILE" 2>/dev/null || echo 0)
    done=$(grep -c '^\- \[x\]' "$TASKS_FILE" 2>/dev/null || echo 0)
    echo -e "${DIM}Total: $total | Open: ${GREEN}$open${NC}${DIM} | Done: ${YELLOW}$done${NC}"
}

# -- Commands ----------------------------------------------------------------

cmd_list() {
    print_header

    if [ ! -f "$TASKS_FILE" ]; then
        echo -e "${RED}Tasks.md not found at $TASKS_FILE${NC}"
        exit 1
    fi

    local current_section=""
    local found_any=false

    while IFS= read -r line; do
        # Track section headers
        if [[ "$line" =~ ^##\  ]]; then
            current_section="$line"
            continue
        fi

        # Show unchecked tasks with their section
        if [[ "$line" =~ ^-\ \[\ \] ]]; then
            if [ "$found_any" = false ]; then
                found_any=true
            fi
            # Print section header if we haven't for this group
            if [ -n "$current_section" ]; then
                echo -e "\n${BOLD}${CYAN}$current_section${NC}"
                current_section=""
            fi
            # Strip the checkbox prefix and print
            local task_text="${line#- \[ \] }"
            echo -e "  ${YELLOW}[ ]${NC} $task_text"
        fi
    done < "$TASKS_FILE"

    if [ "$found_any" = false ]; then
        echo -e "${GREEN}No open tasks found.${NC}"
    fi

    echo ""
    count_tasks
}

cmd_add() {
    local section="$1"
    local task="$2"

    if [ ! -f "$TASKS_FILE" ]; then
        echo -e "${RED}Tasks.md not found at $TASKS_FILE${NC}"
        exit 1
    fi

    # Find the section (case-insensitive partial match)
    local section_line
    section_line=$(grep -n "^## " "$TASKS_FILE" | grep -i "$section" | head -1)

    if [ -z "$section_line" ]; then
        echo -e "${RED}Section matching '$section' not found.${NC}"
        echo -e "${DIM}Available sections:${NC}"
        grep "^## " "$TASKS_FILE" | while read -r s; do
            echo -e "  $s"
        done
        exit 1
    fi

    local line_num
    line_num=$(echo "$section_line" | cut -d: -f1)
    local section_name
    section_name=$(echo "$section_line" | cut -d: -f2-)

    echo -e "${DIM}Found section: ${NC}$section_name"

    # Find the last task line in this section (before next ## or EOF)
    local next_section_line
    next_section_line=$(awk "NR>$line_num && /^## /{print NR; exit}" "$TASKS_FILE")

    local insert_line
    if [ -n "$next_section_line" ]; then
        # Find the last non-empty line before the next section
        insert_line=$((next_section_line - 1))
        # Walk backwards past blank lines
        while [ "$insert_line" -gt "$line_num" ]; do
            local content
            content=$(sed -n "${insert_line}p" "$TASKS_FILE")
            if [ -n "$content" ]; then
                break
            fi
            insert_line=$((insert_line - 1))
        done
    else
        # Last section in file -- append at end
        insert_line=$(wc -l < "$TASKS_FILE")
    fi

    # Insert the new task after insert_line
    local new_task="- [ ] $task"
    sed -i "${insert_line}a\\${new_task}" "$TASKS_FILE"

    echo -e "${GREEN}Added:${NC} $new_task"
    echo -e "${DIM}After line $insert_line in $section_name${NC}"

    vault_commit "added task: $task"
    echo -e "${GREEN}Vault committed.${NC}"
}

cmd_done() {
    local search="$1"

    if [ ! -f "$TASKS_FILE" ]; then
        echo -e "${RED}Tasks.md not found at $TASKS_FILE${NC}"
        exit 1
    fi

    # Find matching unchecked tasks
    local matches
    matches=$(grep -n "^\- \[ \].*$search" "$TASKS_FILE" 2>/dev/null || true)

    if [ -z "$matches" ]; then
        echo -e "${RED}No unchecked tasks matching '$search' found.${NC}"
        exit 1
    fi

    local match_count
    match_count=$(echo "$matches" | wc -l)

    if [ "$match_count" -gt 1 ]; then
        echo -e "${YELLOW}Multiple matches found:${NC}"
        echo "$matches" | while IFS= read -r m; do
            local ln task
            ln=$(echo "$m" | cut -d: -f1)
            task=$(echo "$m" | cut -d: -f2-)
            echo -e "  ${DIM}L$ln:${NC} $task"
        done
        echo ""
        echo -e "${YELLOW}Be more specific, or use exact text to match one task.${NC}"
        exit 1
    fi

    # Single match -- mark done
    local line_num
    line_num=$(echo "$matches" | cut -d: -f1)
    local task_text
    task_text=$(echo "$matches" | cut -d: -f2-)

    sed -i "${line_num}s/- \[ \]/- [x]/" "$TASKS_FILE"

    echo -e "${GREEN}Done:${NC} ${task_text/\- \[ \]/- [x]}"

    vault_commit "completed task: $(echo "$task_text" | sed 's/- \[ \] //')"
    echo -e "${GREEN}Vault committed.${NC}"
}

cmd_search() {
    local keyword="$1"

    if [ ! -f "$TASKS_FILE" ]; then
        echo -e "${RED}Tasks.md not found at $TASKS_FILE${NC}"
        exit 1
    fi

    print_header
    echo -e "Searching for: ${BOLD}$keyword${NC}"
    echo ""

    local current_section=""
    local found=false

    while IFS= read -r line; do
        if [[ "$line" =~ ^##\  ]]; then
            current_section="$line"
            continue
        fi

        if [[ "$line" =~ ^\-\ \[.*\] ]] && echo "$line" | grep -qi "$keyword"; then
            found=true
            if [ -n "$current_section" ]; then
                echo -e "\n${BOLD}${CYAN}$current_section${NC}"
                current_section=""
            fi

            if [[ "$line" =~ ^\-\ \[x\] ]]; then
                echo -e "  ${DIM}[x] ${line#- \[x\] }${NC}"
            else
                echo -e "  ${YELLOW}[ ]${NC} ${line#- \[ \] }"
            fi
        fi
    done < "$TASKS_FILE"

    if [ "$found" = false ]; then
        echo -e "${DIM}No tasks matching '$keyword'.${NC}"
    fi
}

# -- Help --------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}apex-tasks.sh${NC} -- Emergency vault task management (no AI)"
    echo ""
    echo -e "${BOLD}USAGE:${NC}"
    echo "  apex-tasks.sh list                           Show all open tasks"
    echo "  apex-tasks.sh add \"section\" \"description\"    Add task to a section"
    echo "  apex-tasks.sh done \"search text\"             Mark matching task done"
    echo "  apex-tasks.sh search \"keyword\"               Search all tasks"
    echo "  apex-tasks.sh --help                         Show this help"
    echo ""
    echo -e "${BOLD}EXAMPLES:${NC}"
    echo "  apex-tasks.sh list"
    echo "  apex-tasks.sh add \"Core\" \"Build emergency CLI toolkit\""
    echo "  apex-tasks.sh done \"emergency CLI\""
    echo "  apex-tasks.sh search \"voice\""
    echo ""
    echo -e "${DIM}Vault: $VAULT${NC}"
    echo -e "${DIM}Auto-commits after every write.${NC}"
}

# -- Main --------------------------------------------------------------------
case "${1:---help}" in
    list)
        cmd_list
        ;;
    add)
        if [ $# -lt 3 ]; then
            echo -e "${RED}Usage: apex-tasks.sh add \"section name\" \"task description\"${NC}"
            exit 1
        fi
        cmd_add "$2" "$3"
        ;;
    done)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-tasks.sh done \"search string\"${NC}"
            exit 1
        fi
        cmd_done "$2"
        ;;
    search)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-tasks.sh search \"keyword\"${NC}"
            exit 1
        fi
        cmd_search "$2"
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
