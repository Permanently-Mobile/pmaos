#!/usr/bin/env bash
# Auto-commit vault changes after the bot writes/edits vault files.
# Usage: bash vault-commit.sh "action description"
# Called by the primary bot after any Write/Edit to the vault.

BOT_NAME="${BOT_NAME:-apex-bot}"
VAULT="${VAULT_ROOT:-}"
MSG="${1:-${BOT_NAME}: vault update}"

cd "$VAULT" || exit 1

# Only commit if there are actual changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

git add -A
git commit -m "${BOT_NAME}: $MSG" --quiet 2>/dev/null
