#!/usr/bin/env bash
# ============================================================================
# apex-systems.sh -- Emergency PM2 & service management (no AI required)
# Part of Layer 1: Provider-Independent Emergency CLI Toolkit
# ============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

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
    echo -e "${BOLD}${CYAN}=== APEX SYSTEMS ===${NC}"
    echo ""
}

check_pm2() {
    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${RED}pm2 not found. Install with: npm i -g pm2${NC}"
        exit 1
    fi
}

# -- Commands ----------------------------------------------------------------

cmd_status() {
    print_header
    check_pm2

    echo -e "${BOLD}PM2 Process Status:${NC}"
    echo ""

    # Get pm2 jlist for structured output
    local jlist
    jlist=$(pm2 jlist 2>/dev/null || echo "[]")

    if [ "$jlist" = "[]" ]; then
        echo -e "${YELLOW}No PM2 processes running.${NC}"
        return
    fi

    # Format: name | status | cpu | mem | uptime | restarts
    printf "${BOLD}%-16s %-10s %-8s %-10s %-14s %-10s${NC}\n" "NAME" "STATUS" "CPU" "MEMORY" "UPTIME" "RESTARTS"
    echo "------------------------------------------------------------------------"

    echo "$jlist" | node -e "
        const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        data.forEach(p => {
            const name = p.name || '?';
            const status = p.pm2_env?.status || '?';
            const cpu = (p.monit?.cpu || 0) + '%';
            const mem = ((p.monit?.memory || 0) / 1024 / 1024).toFixed(1) + 'MB';
            const uptime = p.pm2_env?.pm_uptime ? msToHuman(Date.now() - p.pm2_env.pm_uptime) : '?';
            const restarts = p.pm2_env?.restart_time || 0;

            const statusColor = status === 'online' ? '\x1b[32m' : status === 'stopped' ? '\x1b[33m' : '\x1b[31m';
            const nc = '\x1b[0m';

            console.log(
                name.padEnd(16) +
                statusColor + status.padEnd(10) + nc +
                cpu.padEnd(8) +
                mem.padEnd(10) +
                uptime.padEnd(14) +
                String(restarts).padEnd(10)
            );
        });

        function msToHuman(ms) {
            const s = Math.floor(ms/1000);
            if (s < 60) return s + 's';
            const m = Math.floor(s/60);
            if (m < 60) return m + 'm';
            const h = Math.floor(m/60);
            if (h < 24) return h + 'h ' + (m%60) + 'm';
            const d = Math.floor(h/24);
            return d + 'd ' + (h%24) + 'h';
        }
    " 2>/dev/null || pm2 status
}

cmd_restart() {
    local name="$1"
    check_pm2
    echo -e "${YELLOW}Restarting $name...${NC}"
    pm2 restart "$name"
    echo -e "${GREEN}$name restarted.${NC}"
}

cmd_logs() {
    local name="$1"
    local lines="${2:-30}"
    check_pm2
    echo -e "${BOLD}${CYAN}Logs for $name (last $lines lines):${NC}"
    echo ""
    pm2 logs "$name" --lines "$lines" --nostream 2>&1 || true
}

cmd_health() {
    print_header
    check_pm2

    # PM2 summary
    echo -e "${BOLD}PM2 Processes:${NC}"
    local total online stopped errored
    total=$(pm2 jlist 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.length)" 2>/dev/null || echo 0)
    online=$(pm2 jlist 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='online').length)" 2>/dev/null || echo 0)
    stopped=$(pm2 jlist 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='stopped').length)" 2>/dev/null || echo 0)
    errored=$(pm2 jlist 2>/dev/null | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.filter(p=>p.pm2_env?.status==='errored').length)" 2>/dev/null || echo 0)

    echo -e "  Total: $total | ${GREEN}Online: $online${NC} | ${YELLOW}Stopped: $stopped${NC} | ${RED}Errored: $errored${NC}"

    # Show errored processes if any
    if [ "$errored" -gt 0 ] 2>/dev/null; then
        echo -e "\n${RED}  Errored processes:${NC}"
        pm2 jlist 2>/dev/null | node -e "
            const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            d.filter(p=>p.pm2_env?.status==='errored').forEach(p=>console.log('    - ' + p.name + ' (restarts: ' + (p.pm2_env?.restart_time||0) + ')'));
        " 2>/dev/null
    fi

    # Disk space
    echo -e "\n${BOLD}Disk:${NC}"
    if command -v df >/dev/null 2>&1; then
        df -h / 2>/dev/null | tail -1 | awk '{
            used=$3; avail=$4; pct=$5;
            gsub(/%/,"",pct);
            color = (pct+0 > 90) ? "\033[31m" : (pct+0 > 70) ? "\033[33m" : "\033[32m";
            printf "  Used: %s | Available: %s | %s%s%%\033[0m\n", used, avail, color, pct
        }'
    else
        echo -e "  ${DIM}df not available${NC}"
    fi

    # RAM
    echo -e "\n${BOLD}Memory:${NC}"
    if command -v free >/dev/null 2>&1; then
        free -h 2>/dev/null | awk '/^Mem:/ {
            total=$2; used=$3; avail=$7;
            printf "  Total: %s | Used: %s | Available: %s\n", total, used, avail
        }'
    elif command -v wmic >/dev/null 2>&1; then
        # Windows (Git Bash)
        local total_kb free_kb
        total_kb=$(wmic OS get TotalVisibleMemorySize /value 2>/dev/null | grep -o '[0-9]*' || echo 0)
        free_kb=$(wmic OS get FreePhysicalMemory /value 2>/dev/null | grep -o '[0-9]*' || echo 0)
        if [ "$total_kb" -gt 0 ] 2>/dev/null; then
            local total_gb free_gb used_gb pct
            total_gb=$(echo "scale=1; $total_kb / 1048576" | bc 2>/dev/null || echo "?")
            free_gb=$(echo "scale=1; $free_kb / 1048576" | bc 2>/dev/null || echo "?")
            used_gb=$(echo "scale=1; ($total_kb - $free_kb) / 1048576" | bc 2>/dev/null || echo "?")
            pct=$(echo "scale=0; ($total_kb - $free_kb) * 100 / $total_kb" | bc 2>/dev/null || echo "?")
            echo -e "  Total: ${total_gb}G | Used: ${used_gb}G | Free: ${free_gb}G | ${pct}%"
        else
            echo -e "  ${DIM}Could not read memory info${NC}"
        fi
    else
        echo -e "  ${DIM}Memory info not available${NC}"
    fi

    # Node version
    echo -e "\n${BOLD}Runtime:${NC}"
    echo -e "  Node: $(node -v 2>/dev/null || echo 'not found')"
    echo -e "  PM2: $(pm2 -v 2>/dev/null || echo 'not found')"
}

cmd_providers() {
    print_header
    echo -e "${BOLD}Provider Health Check:${NC}"
    echo ""

    # Load .env or .env.age
    local env_file=""
    if [ -f "$PROJECT_ROOT/.env" ]; then
        env_file="$PROJECT_ROOT/.env"
    fi

    # Check Anthropic
    echo -n "  Anthropic API:     "
    local anthropic_status
    anthropic_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        -H "x-api-key: test" \
        -H "anthropic-version: 2023-06-01" \
        "https://api.anthropic.com/v1/messages" 2>/dev/null || echo "000")
    if [ "$anthropic_status" = "401" ] || [ "$anthropic_status" = "400" ]; then
        echo -e "${GREEN}reachable${NC} (HTTP $anthropic_status)"
    elif [ "$anthropic_status" = "000" ]; then
        echo -e "${RED}unreachable${NC} (timeout/DNS failure)"
    else
        echo -e "${YELLOW}HTTP $anthropic_status${NC}"
    fi

    # Check OpenRouter
    echo -n "  OpenRouter API:    "
    local openrouter_status
    openrouter_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        "https://openrouter.ai/api/v1/models" 2>/dev/null || echo "000")
    if [ "$openrouter_status" = "200" ]; then
        echo -e "${GREEN}reachable${NC} (HTTP $openrouter_status)"
    elif [ "$openrouter_status" = "000" ]; then
        echo -e "${RED}unreachable${NC} (timeout/DNS failure)"
    else
        echo -e "${YELLOW}HTTP $openrouter_status${NC}"
    fi

    # Check Venice
    echo -n "  Venice API:        "
    local venice_status
    venice_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        "https://api.venice.ai/api/v1/models" 2>/dev/null || echo "000")
    if [ "$venice_status" = "200" ] || [ "$venice_status" = "401" ]; then
        echo -e "${GREEN}reachable${NC} (HTTP $venice_status)"
    elif [ "$venice_status" = "000" ]; then
        echo -e "${RED}unreachable${NC} (timeout/DNS failure)"
    else
        echo -e "${YELLOW}HTTP $venice_status${NC}"
    fi

    # Check Ollama (local)
    echo -n "  Ollama (local):    "
    local ollama_status
    ollama_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 \
        "http://localhost:11434/api/tags" 2>/dev/null || echo "000")
    if [ "$ollama_status" = "200" ]; then
        echo -e "${GREEN}running${NC}"
    elif [ "$ollama_status" = "000" ]; then
        echo -e "${DIM}not running${NC}"
    else
        echo -e "${YELLOW}HTTP $ollama_status${NC}"
    fi

    # Check ElevenLabs
    echo -n "  ElevenLabs:        "
    local eleven_status
    eleven_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        "https://api.elevenlabs.io/v1/voices" 2>/dev/null || echo "000")
    if [ "$eleven_status" = "401" ] || [ "$eleven_status" = "200" ]; then
        echo -e "${GREEN}reachable${NC} (HTTP $eleven_status)"
    elif [ "$eleven_status" = "000" ]; then
        echo -e "${RED}unreachable${NC}"
    else
        echo -e "${YELLOW}HTTP $eleven_status${NC}"
    fi
}

# -- Help --------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}apex-systems.sh${NC} -- Emergency PM2 & service management (no AI)"
    echo ""
    echo -e "${BOLD}USAGE:${NC}"
    echo "  apex-systems.sh status                Show all PM2 processes"
    echo "  apex-systems.sh restart <name>        Restart a PM2 process"
    echo "  apex-systems.sh logs <name> [lines]   Show logs (default: 30 lines)"
    echo "  apex-systems.sh health                Quick health: PM2 + disk + RAM"
    echo "  apex-systems.sh providers             Ping all configured providers"
    echo "  apex-systems.sh --help                Show this help"
    echo ""
    echo -e "${BOLD}EXAMPLES:${NC}"
    echo "  apex-systems.sh status"
    echo "  apex-systems.sh restart ${BOT_NAME:-apex-bot}"
    echo "  apex-systems.sh logs researcher-1 50"
    echo "  apex-systems.sh health"
    echo "  apex-systems.sh providers"
    echo ""
    echo -e "${DIM}Project: $PROJECT_ROOT${NC}"
}

# -- Main --------------------------------------------------------------------
case "${1:---help}" in
    status)
        cmd_status
        ;;
    restart)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-systems.sh restart <name>${NC}"
            exit 1
        fi
        cmd_restart "$2"
        ;;
    logs)
        if [ $# -lt 2 ]; then
            echo -e "${RED}Usage: apex-systems.sh logs <name> [lines]${NC}"
            exit 1
        fi
        cmd_logs "$2" "${3:-30}"
        ;;
    health)
        cmd_health
        ;;
    providers)
        cmd_providers
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
