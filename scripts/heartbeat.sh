#!/usr/bin/env bash
# ─────────────────────────────────────────────────
# heartbeat.sh
# Checks that all PMAOS services are alive.
# Only alerts via Telegram if something is DOWN.
# Silent when everything is healthy.
# Runs every 10 minutes via cron/task scheduler.
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
NOTIFY="$SCRIPT_DIR/notify.sh"
LOG_FILE="$PROJECT_DIR/store/heartbeat.log"

# Read bot token (try .env first, then decrypt .env.age)
if [ -f "$ENV_FILE" ]; then
  BOT_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
else
  AGE_KEY="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
  AGE_BIN=$(command -v age 2>/dev/null)
  if [ -z "$AGE_BIN" ]; then
    AGE_BIN=$(find "${LOCALAPPDATA:-/dev/null}/Microsoft/WinGet/Packages" -name "age.exe" 2>/dev/null | head -1)
  fi
  if [ -n "$AGE_BIN" ] && [ -f "$AGE_KEY" ] && [ -f "$PROJECT_DIR/.env.age" ]; then
    ENV_CONTENT=$("$AGE_BIN" -d -i "$AGE_KEY" "$PROJECT_DIR/.env.age" 2>/dev/null)
    BOT_TOKEN=$(echo "$ENV_CONTENT" | grep -E '^TELEGRAM_BOT_TOKEN=' | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  fi
fi

BOT_NAME="${BOT_NAME:-apex-bot}"
SECONDARY_BOT="${SECONDARY_BOT:-}"

FAILURES=()
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# ── 1. Check PM2 is running ────────────────────
if ! command -v pm2 &>/dev/null; then
  FAILURES+=("PM2 not found in PATH")
else
  # Check primary bot
  PRIMARY_STATUS=$(pm2 jlist 2>/dev/null | BOT_NAME="${BOT_NAME}" node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const a=JSON.parse(d);const p=a.find(x=>x.name===process.env.BOT_NAME);
      console.log(p?p.pm2_env.status:'not_found')}catch{console.log('error')}
    })
  ")
  if [ "$PRIMARY_STATUS" != "online" ]; then
    FAILURES+=("${BOT_NAME} is $PRIMARY_STATUS")
    # Attempt auto-restart
    pm2 restart "${BOT_NAME}" 2>/dev/null && FAILURES+=("(attempted restart)")
  fi

  # Check secondary bot (if configured)
  SECONDARY_STATUS="not_configured"
  if [ -n "$SECONDARY_BOT" ]; then
    SECONDARY_STATUS=$(pm2 jlist 2>/dev/null | SECONDARY_BOT="${SECONDARY_BOT}" node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const a=JSON.parse(d);const p=a.find(x=>x.name===process.env.SECONDARY_BOT);
        console.log(p?p.pm2_env.status:'not_found')}catch{console.log('error')}
      })
    ")
    if [ "$SECONDARY_STATUS" != "online" ]; then
      FAILURES+=("${SECONDARY_BOT} is $SECONDARY_STATUS")
      pm2 restart "${SECONDARY_BOT}" 2>/dev/null && FAILURES+=("(attempted restart)")
    fi
  fi
fi

# ── 2. Check Ollama is responding ───────────────
OLLAMA_CHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:11434/api/tags 2>/dev/null)
if [ "$OLLAMA_CHECK" != "200" ]; then
  FAILURES+=("Ollama not responding (HTTP $OLLAMA_CHECK)")
fi

# ── 3. Check disk space (warn if < 10% free) ───
# Disk space check -- works on both Windows (Git Bash) and Linux
if [ -d "/c" ]; then
  # Windows (Git Bash / MSYS2): check C: and D: drives
  DISK1_USED=$(df -h /c 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
  DISK1_LABEL="C:"
  DISK2_USED=$(df -h /d 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
  DISK2_LABEL="D:"
else
  # Linux: check root and /home (or data mount)
  DISK1_USED=$(df -h / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
  DISK1_LABEL="/"
  DISK2_USED=$(df -h /home 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')
  DISK2_LABEL="/home"
fi

if [ -n "$DISK1_USED" ] && [ "$DISK1_USED" -gt 90 ] 2>/dev/null; then
  FAILURES+=("$DISK1_LABEL drive ${DISK1_USED}% full")
fi
if [ -n "$DISK2_USED" ] && [ "$DISK2_USED" -gt 90 ] 2>/dev/null; then
  FAILURES+=("$DISK2_LABEL drive ${DISK2_USED}% full")
fi

# ── 4. Check primary bot's DB is accessible ───────────
PRIMARY_DB="$PROJECT_DIR/store/apex.db"
if [ ! -f "$PRIMARY_DB" ]; then
  FAILURES+=("Primary bot DB missing at $PRIMARY_DB")
fi

# ── 5. Check secondary bot's DB exists ──────────────────
if [ -n "$SECONDARY_BOT" ]; then
  SECONDARY_DB="$PROJECT_DIR/bots/${SECONDARY_BOT}/store/apex.db"
  if [ ! -f "$SECONDARY_DB" ]; then
    # Not a failure if secondary bot hasn't created it yet, just note it
    :
  fi
fi

# ── 6. Check Telegram API reachable ────────────
# Use bot getMe endpoint -- confirms connectivity AND valid token
TG_CHECK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null)
if [ "$TG_CHECK" != "200" ]; then
  FAILURES+=("Telegram API unreachable (HTTP $TG_CHECK)")
fi

# ── Log result ──────────────────────────────────
if [ ${#FAILURES[@]} -eq 0 ]; then
  echo "$TIMESTAMP | OK | primary=$PRIMARY_STATUS secondary=$SECONDARY_STATUS ollama=$OLLAMA_CHECK ${DISK1_LABEL}=${DISK1_USED}% ${DISK2_LABEL}=${DISK2_USED}%" >> "$LOG_FILE"
else
  FAIL_MSG=$(printf "%s\n" "${FAILURES[@]}")
  echo "$TIMESTAMP | FAIL | $FAIL_MSG" >> "$LOG_FILE"

  # Alert via Telegram
  ALERT="⚠️ Heartbeat Alert\n\n"
  for f in "${FAILURES[@]}"; do
    ALERT+="- $f\n"
  done
  ALERT+="\n$TIMESTAMP"

  bash "$NOTIFY" "$(echo -e "$ALERT")"
fi

# ── Trim log to last 1000 lines ────────────────
if [ -f "$LOG_FILE" ]; then
  LINES=$(wc -l < "$LOG_FILE")
  if [ "$LINES" -gt 1000 ]; then
    tail -500 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi
fi
