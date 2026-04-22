#!/usr/bin/env bash
# ============================================================================
# apex-bridge.sh -- Emergency bridge queue management (no AI required)
# Part of Layer 1: Provider-Independent Emergency CLI Toolkit
# ============================================================================

set -euo pipefail

# -- Config ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"
BRIDGE_CLI="$PROJECT_ROOT/dist/bridge-cli.js"

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
    echo -e "${BOLD}${CYAN}=== APEX BRIDGE ===${NC}"
    echo ""
}

check_bridge() {
    if [ ! -f "$BRIDGE_CLI" ]; then
        echo -e "${RED}Bridge CLI not found at $BRIDGE_CLI${NC}"
        echo -e "${DIM}Run 'npm run build' in $PROJECT_ROOT to compile.${NC}"
        exit 1
    fi
}

# -- Commands ----------------------------------------------------------------

cmd_status() {
    print_header
    check_bridge
    echo -e "${BOLD}Bridge Queue Status:${NC}"
    echo ""
    node "$BRIDGE_CLI" status 2>&1
}

cmd_results() {
    print_header
    check_bridge

    local agent="${2:-}"
    echo -e "${BOLD}Completed Results:${NC}"
    echo ""

    if [ -n "$agent" ]; then
        node "$BRIDGE_CLI" results "$agent" 2>&1
    else
        node "$BRIDGE_CLI" results 2>&1
    fi
}

cmd_send() {
    local agent="$1"
    local prompt="$2"

    check_bridge

    echo -e "${YELLOW}Dispatching to $agent...${NC}"
    echo -e "${DIM}Prompt: ${prompt:0:80}...${NC}"
    echo ""
    node "$BRIDGE_CLI" send "$agent" "$prompt" 2>&1

    echo ""
    echo -e "${GREEN}Task queued for $agent.${NC}"
}

cmd_pending() {
    print_header
    check_bridge
    echo -e "${BOLD}Pending Tasks:${NC}"
    echo ""
    node "$BRIDGE_CLI" pending 2>&1
}

# -- Help --------------------------------------------------------------------
cmd_help() {
    echo -e "${BOLD}${CYAN}apex-bridge.sh${NC} -- Emergency bridge queue management (no AI)"
    echo ""
    echo -e "${BOLD}USAGE:${NC}"
    echo "  apex-bridge.sh status                 Show queue statistics"
    echo "  apex-bridge.sh results [agent]        Show completed results"
    echo "  apex-bridge.sh send <agent> <prompt>  Queue a task for an agent"
    echo "  apex-bridge.sh pending                Show pending tasks only"
    echo "  apex-bridge.sh --help                 Show this help"
    echo ""
    echo -e "${BOLD}AGENTS:${NC}"
    echo "  researcher-1, researcher-2    Research agents"
    echo "  coder-1, coder-2, coder-3     Code development agents"
    echo "  processor-1                   Conversation note-taker"
    echo "  auditor                       Audit agent"
    echo "  scout                         Strategy research"
    echo "  creative-1                    Media/production"
    echo ""
    echo -e "${BOLD}EXAMPLES:${NC}"
    echo "  apex-bridge.sh status"
    echo "  apex-bridge.sh results researcher-1"
    echo "  apex-bridge.sh send researcher-1 \"Research best VPN for trading bots\""
    echo "  apex-bridge.sh pending"
    echo ""
    echo -e "${DIM}Bridge CLI: $BRIDGE_CLI${NC}"
}

# -- Main --------------------------------------------------------------------
case "${1:---help}" in
    status)
        cmd_status
        ;;
    results)
        cmd_results "$@"
        ;;
    send)
        if [ $# -lt 3 ]; then
            echo -e "${RED}Usage: apex-bridge.sh send <agent> \"<prompt>\"${NC}"
            exit 1
        fi
        cmd_send "$2" "$3"
        ;;
    pending)
        cmd_pending
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
