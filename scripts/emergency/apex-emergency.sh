#!/usr/bin/env bash
# ============================================================================
# apex-emergency.sh -- Master emergency script (no AI required)
# Part of Layer 1: Provider-Independent Emergency CLI Toolkit
# ============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
VAULT="${VAULT_ROOT:-}"
SCRIPTS_DIR="$PROJECT_ROOT/scripts/emergency"

# -- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# -- Helpers -----------------------------------------------------------------
section() {
    echo ""
    echo -e "${BOLD}${CYAN}--- $1 ---${NC}"
    echo ""
}

# -- Commands ----------------------------------------------------------------

cmd_dashboard() {
    echo -e "${BOLD}${CYAN}============================================${NC}"
    echo -e "${BOLD}${CYAN}   APEX EMERGENCY DASHBOARD${NC}"
    echo -e "${BOLD}${CYAN}   $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${BOLD}${CYAN}============================================${NC}"

    # -- PM2 Status (inline, not calling sub-script) --
    section "PM2 SERVICES"
    if command -v pm2 >/dev/null 2>&1; then
        local jlist
        jlist=$(pm2 jlist 2>/dev/null || echo "[]")

        if [ "$jlist" = "[]" ]; then
            echo -e "${YELLOW}No PM2 processes running.${NC}"
        else
            local total online stopped errored
            total=$(echo "$jlist" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.length)" 2>/dev/null || echo 0)
            online=$(echo "$jlist" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='online').length)" 2>/dev/null || echo 0)
            stopped=$(echo "$jlist" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='stopped').length)" 2>/dev/null || echo 0)
            errored=$(echo "$jlist" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='errored').length)" 2>/dev/null || echo 0)

            echo -e "  Total: $total | ${GREEN}Online: $online${NC} | ${YELLOW}Stopped: $stopped${NC} | ${RED}Errored: $errored${NC}"

            # List errored
            if [ "$errored" -gt 0 ] 2>/dev/null; then
                echo ""
                echo -e "  ${RED}ERRORED:${NC}"
                echo "$jlist" | node -e "
                    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
                    d.filter(p=>p.pm2_env?.status==='errored').forEach(p=>
                        console.log('    ! ' + p.name + ' (restarts: ' + (p.pm2_env?.restart_time||0) + ')')
                    );
                " 2>/dev/null
            fi

            # List stopped
            if [ "$stopped" -gt 0 ] 2>/dev/null; then
                echo ""
                echo -e "  ${YELLOW}STOPPED:${NC}"
                echo "$jlist" | node -e "
                    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
                    d.filter(p=>p.pm2_env?.status==='stopped').forEach(p=>
                        console.log('    - ' + p.name)
                    );
                " 2>/dev/null
            fi
        fi
    else
        echo -e "${RED}pm2 not found${NC}"
    fi

    # -- System Resources --
    section "SYSTEM RESOURCES"

    # Disk
    echo -n "  Disk:    "
    if command -v df >/dev/null 2>&1; then
        df -h / 2>/dev/null | tail -1 | awk '{
            pct=$5; gsub(/%/,"",pct);
            color = (pct+0 > 90) ? "\033[31m" : (pct+0 > 70) ? "\033[33m" : "\033[32m";
            printf "%s%s%% used\033[0m (%s available)\n", color, pct, $4
        }'
    else
        echo -e "${DIM}unavailable${NC}"
    fi

    # RAM
    echo -n "  Memory:  "
    if command -v free >/dev/null 2>&1; then
        free -h 2>/dev/null | awk '/^Mem:/ { printf "%s used / %s total (%s available)\n", $3, $2, $7 }'
    elif command -v wmic >/dev/null 2>&1; then
        local total_kb free_kb
        total_kb=$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -o '[0-9]*' || echo 0)
        free_kb=$(wmic OS get FreePhysicalMemory /value 2>/dev/null | grep -o '[0-9]*' || echo 0)
        if [ "$total_kb" -gt 0 ] 2>/dev/null; then
            local total_gb free_gb pct
            total_gb=$(echo "scale=1; $total_kb / 1048576" | bc 2>/dev/null || echo "?")
            free_gb=$(echo "scale=1; $free_kb / 1048576" | bc 2>/dev/null || echo "?")
            pct=$(echo "scale=0; ($total_kb - $free_kb) * 100 / $total_kb" | bc 2>/dev/null || echo "?")
            echo "${pct}% used (${free_gb}G free / ${total_gb}G total)"
        else
            echo -e "${DIM}unavailable${NC}"
        fi
    else
        echo -e "${DIM}unavailable${NC}"
    fi

    # -- Provider Reachability --
    section "PROVIDER STATUS"

    for provider_info in \
        "Anthropic|https://api.anthropic.com/v1/messages" \
        "OpenRouter|https://openrouter.ai/api/v1/models" \
        "Venice|https://api.venice.ai/api/v1/models" \
        "Ollama|http://localhost:11434/api/tags"; do

        local name url status_code
        name=$(echo "$provider_info" | cut -d'|' -f1)
        url=$(echo "$provider_info" | cut -d'|' -f2)

        printf "  %-14s " "$name:"
        status_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 "$url" 2>/dev/null || echo "000")

        if [ "$status_code" = "000" ]; then
            if [ "$name" = "Ollama" ]; then
                echo -e "${DIM}not running${NC}"
            else
                echo -e "${RED}DOWN${NC}"
            fi
        elif [ "$status_code" = "200" ] || [ "$status_code" = "401" ] || [ "$status_code" = "400" ]; then
            echo -e "${GREEN}UP${NC} ($status_code)"
        else
            echo -e "${YELLOW}DEGRADED${NC} ($status_code)"
        fi
    done

    # -- Bridge Queue --
    section "BRIDGE QUEUE"
    if [ -f "$PROJECT_ROOT/dist/bridge-cli.js" ]; then
        node "$PROJECT_ROOT/dist/bridge-cli.js" status 2>&1 | head -20
    else
        echo -e "${YELLOW}Bridge CLI not compiled. Run 'npm run build'.${NC}"
    fi

    # -- Vault Status --
    section "VAULT"
    if [ -d "$VAULT" ]; then
        local vault_files
        vault_files=$(find "$VAULT" -name "*.md" -not -path "*/.git/*" -type f 2>/dev/null | wc -l)
        echo -e "  Location: $VAULT"
        echo -e "  Files: $vault_files .md files"

        # Last commit
        local last_commit
        last_commit=$(cd "$VAULT" && git log --oneline -1 2>/dev/null || echo "no git history")
        echo -e "  Last commit: ${DIM}$last_commit${NC}"

        # Today's daily note
        local today
        today=$(date '+%Y-%m-%d')
        if [ -f "$VAULT/Daily Notes/$today.md" ]; then
            echo -e "  Daily note: ${GREEN}exists${NC}"
        else
            echo -e "  Daily note: ${YELLOW}not created yet${NC}"
        fi
    else
        echo -e "  ${RED}Vault not found at $VAULT${NC}"
    fi

    # -- Open Tasks Summary --
    section "OPEN TASKS (top 10)"
    if [ -f "$VAULT/Tasks.md" ]; then
        grep '^\- \[ \]' "$VAULT/Tasks.md" | head -10 | while IFS= read -r line; do
            local task="${line#- \[ \] }"
            # Truncate long tasks
            if [ ${#task} -gt 75 ]; then
                task="${task:0:72}..."
            fi
            echo -e "  ${YELLOW}[ ]${NC} $task"
        done
        local total_open
        total_open=$(grep -c '^\- \[ \]' "$VAULT/Tasks.md" 2>/dev/null || echo 0)
        echo -e "\n  ${DIM}($total_open total open tasks)${NC}"
    else
        echo -e "  ${RED}Tasks.md not found${NC}"
    fi

    echo ""
    echo -e "${BOLD}${CYAN}============================================${NC}"
    echo -e "${DIM}Run 'apex-emergency.sh --help' for commands${NC}"
}

cmd_restart_all() {
    echo -e "${YELLOW}Restarting all PM2 processes...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 restart all
        echo -e "${GREEN}All processes restarted.${NC}"
    else
        echo -e "${RED}pm2 not found${NC}"
        exit 1
    fi
}

cmd_switch_provider() {
    local provider="$1"
    local env_file="$PROJECT_ROOT/.env"

    echo -e "${BOLD}Switching fallback provider to: $provider${NC}"

    if [ ! -f "$env_file" ]; then
        echo -e "${RED}.env file not found at $env_file${NC}"
        echo -e "${DIM}If using .env.age, decrypt first or edit manually.${NC}"
        exit 1
    fi

    # Check if FALLBACK_MODEL_PROVIDER exists in .env
    if grep -q "^FALLBACK_MODEL_PROVIDER=" "$env_file" 2>/dev/null; then
        sed -i "s/^FALLBACK_MODEL_PROVIDER=.*/FALLBACK_MODEL_PROVIDER=$provider/" "$env_file"
        echo -e "${GREEN}Updated FALLBACK_MODEL_PROVIDER=$provider${NC}"
    else
        echo "FALLBACK_MODEL_PROVIDER=$provider" >> "$env_file"
        echo -e "${GREEN}Added FALLBACK_MODEL_PROVIDER=$provider${NC}"
    fi

    echo ""
    echo -e "${YELLOW}Restart services for change to take effect:${NC}"
    echo "  apex-emergency.sh restart-all"
    echo "  -- or --"
    echo "  apex-systems.sh restart ${BOT_NAME:-apex-bot}"
}

# -- Help --------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}apex-emergency.sh${NC} -- Master emergency control panel (no AI)"
    echo ""
    echo -e "${BOLD}USAGE:${NC}"
    echo "  apex-emergency.sh                              Full dashboard"
    echo "  apex-emergency.sh restart-all                  Restart all PM2 services"
    echo "  apex-emergency.sh switch-provider <provider>   Switch fallback provider"
    echo "  apex-emergency.sh --help                       Show this help"
    echo ""
    echo -e "${BOLD}PROVIDERS:${NC}"
    echo "  openrouter    OpenRouter (multi-model gateway)"
    echo "  venice        Venice AI (privacy-first)"
    echo "  ollama        Ollama (local models)"
    echo ""
    echo -e "${BOLD}COMPANION SCRIPTS:${NC}"
    echo "  apex-tasks.sh       Task management"
    echo "  apex-vault.sh       Vault file access"
    echo "  apex-systems.sh     PM2 & service management"
    echo "  apex-bridge.sh      Bridge queue management"
    echo ""
    echo -e "${BOLD}EXAMPLES:${NC}"
    echo "  apex-emergency.sh                              # Full status overview"
    echo "  apex-emergency.sh restart-all                  # Restart everything"
    echo "  apex-emergency.sh switch-provider openrouter   # Switch to OpenRouter"
    echo ""
    echo -e "${DIM}All scripts in: $SCRIPTS_DIR${NC}"
}

# -- Main --------------------------------------------------------------------
case "${1:---dashboard}" in
    --dashboard)
        cmd_dashboard
        ;;
    restart-all)
        cmd_restart_all
        ;;
    switch-provider)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-emergency.sh switch-provider <provider>${NC}"
            echo -e "${DIM}Providers: openrouter, venice, ollama${NC}"
            exit 1
        fi
        cmd_switch_provider "$2"
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
