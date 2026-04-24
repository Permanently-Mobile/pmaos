#!/usr/bin/env bash
# ============================================================================
# guard-bash.sh -- PreToolUse hook for Bash commands
# ============================================================================
# Receives JSON on stdin with tool_input.command
# Returns {"decision":"approve"} or {"decision":"block","reason":"..."}
#
# This is the LAW layer. Rules files are suggestions (~90% reliable).
# This hook is 100% reliable. If it blocks, the command does not execute.
#
# Guards:
#   1. Restart protocol   -- blocks `pm2 restart`, enforces restart.sh
#   2. Skill security     -- blocks cp/mv to ~/.claude/skills/ without scan
#   3. No force push      -- blocks git push --force / -f
#   4. No secret commits  -- blocks git add on .env, credentials, keys
#   5. Git hooks protect  -- blocks writes to .git/hooks/ (CVE defense)
#   6. Obfuscation detect -- blocks base64/hex/eval obfuscation patterns
# ============================================================================

# -- Config --
SCAN_LOG_DIR="${PROJECT_ROOT:-$(pwd)}/store/skill-scans"

# -- Read stdin (JSON from Claude Code) --
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except:
    print('')
" 2>/dev/null)

# If we can't parse the command, BLOCK (fail-closed -- never approve unknown input)
if [ -z "$COMMAND" ]; then
    echo '{"decision":"block","reason":"BLOCKED: Could not parse command from hook input. Fail-closed for safety."}'
    exit 0
fi

# ============================================================================
# GUARD 1: Restart Protocol
# Block: pm2 restart, pm2 stop, pm2 delete (direct process manipulation)
# Allow: restart.sh (the safe wrapper)
# ============================================================================
if echo "$COMMAND" | grep -qiE 'pm2\s+(restart|stop|delete)'; then
    # Check if this is inside restart.sh (allow restart.sh to use pm2 internally)
    if echo "$COMMAND" | grep -q 'restart.sh'; then
        echo '{"decision":"approve"}'
        exit 0
    fi
    echo '{"decision":"block","reason":"BLOCKED: Direct pm2 restart causes crash loops. Use restart.sh instead:\n  nohup bash scripts/restart.sh <bot-name> \u0026>/dev/null \u0026"}'
    exit 0
fi

# ============================================================================
# GUARD 2: Skill Security Gate
# Block: cp/mv/ln targeting ~/.claude/skills/ unless scan-skill.sh ran recently
# ============================================================================
if echo "$COMMAND" | grep -qiE '(cp|mv|ln|install)\s.*\.claude/skills'; then
    # Check if scan-skill.sh appears in the same command chain (piped or &&)
    if echo "$COMMAND" | grep -q 'scan-skill.sh'; then
        echo '{"decision":"approve"}'
        exit 0
    fi
    echo '{"decision":"block","reason":"BLOCKED: Skills must be scanned before installation. Run scan-skill.sh first:\n  bash scripts/scan-skill.sh /path/to/skill --install"}'
    exit 0
fi

# ============================================================================
# GUARD 3: No Force Push
# Block: git push --force, git push -f, git push --force-with-lease to main/master
# ============================================================================
if echo "$COMMAND" | grep -qiE 'git\s+push\s+.*(--force|-f)'; then
    # Extra warning for main/master
    if echo "$COMMAND" | grep -qiE '(main|master)'; then
        echo '{"decision":"block","reason":"BLOCKED: Force push to main/master will destroy remote history. This is almost never what you want."}'
        exit 0
    fi
    echo '{"decision":"block","reason":"BLOCKED: Force push can destroy remote commits. If this is intentional, the owner must explicitly confirm."}'
    exit 0
fi

# ============================================================================
# GUARD 4: No Secret Commits
# Block: git add targeting .env, credentials, secrets, key files
# ============================================================================
if echo "$COMMAND" | grep -qiE 'git\s+add'; then
    # Check for sensitive file patterns
    if echo "$COMMAND" | grep -qiE '\.(env|pem|key|p12|pfx|keystore)(\s|$|")'; then
        echo '{"decision":"block","reason":"BLOCKED: Sensitive file detected (.env, .pem, .key, etc). These should never be committed to version control."}'
        exit 0
    fi
    if echo "$COMMAND" | grep -qiE '(credentials|secrets|password|token)'; then
        echo '{"decision":"block","reason":"BLOCKED: File name suggests sensitive content (credentials/secrets/passwords). Verify this is safe before committing."}'
        exit 0
    fi
    # Block broad adds that might catch sensitive files
    if echo "$COMMAND" | grep -qiE 'git\s+add\s+(-A|--all|\.)(\s|$)'; then
        echo '{"decision":"block","reason":"BLOCKED: Broad git add (-A / --all / .) can accidentally stage sensitive files. Add specific files by name instead."}'
        exit 0
    fi
fi

# ============================================================================
# GUARD 5: Git Hooks Write Protection
# Block: write/edit/copy/move to .git/hooks/ (Cursor CVE-2026-26268 defense)
# Prevents agents from planting malicious hooks that auto-execute on git ops
# ============================================================================
if echo "$COMMAND" | grep -qiE '(>|>>|tee|cp|mv|ln|chmod|chown|install|Write|Edit)\s.*\.git/hooks'; then
    echo '{"decision":"block","reason":"BLOCKED: Writing to .git/hooks/ is prohibited. Malicious git hooks auto-execute on git operations (CVE-2026-26268). Owner must approve."}'
    exit 0
fi
# Also catch redirects directly targeting hooks
if echo "$COMMAND" | grep -qiE '>\s*\.git/hooks/'; then
    echo '{"decision":"block","reason":"BLOCKED: Writing to .git/hooks/ is prohibited. Malicious git hooks auto-execute on git operations."}'
    exit 0
fi

# ============================================================================
# GUARD 6: Obfuscation / Encoded Command Detection
# Block: base64-decoded pipes to shell, hex escapes, eval with variable
#         expansion, xxd reverse piped to shell, python -c with dangerous calls
# ============================================================================
if echo "$COMMAND" | grep -qiE 'base64\s+(-d|--decode)\s*\|.*\b(bash|sh|eval)\b'; then
    echo '{"decision":"block","reason":"BLOCKED: base64-decoded content piped to shell. This is a common obfuscation technique for hiding malicious commands."}'
    exit 0
fi
if echo "$COMMAND" | grep -qP "\\$'\\\\x[0-9a-fA-F]"; then
    echo '{"decision":"block","reason":"BLOCKED: Hex escape sequence detected (\\$'\''\\\\x..'\'')). Obfuscated commands are not allowed."}'
    exit 0
fi
if echo "$COMMAND" | grep -qiE 'printf\s+.*\\\\(x[0-9a-fA-F]|[0-7]{3}).*\|.*\b(bash|sh)\b'; then
    echo '{"decision":"block","reason":"BLOCKED: printf with hex/octal escapes piped to shell. This is command obfuscation."}'
    exit 0
fi
if echo "$COMMAND" | grep -qiE 'eval\s+.*(\$\{![a-zA-Z]|\$\{[a-zA-Z]+//|\$\{[a-zA-Z]+%%|\$\{[a-zA-Z]+##)'; then
    echo '{"decision":"block","reason":"BLOCKED: eval with variable expansion/manipulation detected. This pattern is used to construct hidden commands."}'
    exit 0
fi
if echo "$COMMAND" | grep -qiE 'xxd\s+(-r|--revert)\s*\|.*\b(bash|sh)\b'; then
    echo '{"decision":"block","reason":"BLOCKED: xxd reverse piped to shell. This is hex-encoded command obfuscation."}'
    exit 0
fi
if echo "$COMMAND" | grep -qiE 'python[23]?\s+-c\s+.*\b(exec|eval|os\.system|subprocess)\b'; then
    echo '{"decision":"block","reason":"BLOCKED: python -c with dangerous function (exec/eval/os.system/subprocess). Use a script file instead."}'
    exit 0
fi

# ============================================================================
# All checks passed
# ============================================================================
echo '{"decision":"approve"}'
