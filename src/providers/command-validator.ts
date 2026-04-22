/**
 * Command Validator -- Parses LLM output for executable commands
 *
 * Detects bash commands, file operations, database queries, git commands,
 * npm/node commands, and system commands from LLM-generated text.
 * Feeds each detected command into the CedarPolicyEngine for evaluation.
 *
 * Designed for standalone extraction (minimal Apex dependencies).
 */

import type { DetectedCommand } from './types.js';

// ── Command detection patterns ──────────────────────────────────────

/** Patterns that indicate a line is an executable command. */
const COMMAND_INDICATORS: RegExp[] = [
  // Shell/bash commands (common prefixes)
  /^\s*(?:\$\s+)?(?:sudo\s+)?(?:bash|sh|zsh|cmd|powershell|pwsh)\s+-c\s+/,
  /^\s*(?:\$\s+)?(?:sudo\s+)?(?:rm|cp|mv|mkdir|touch|chmod|chown|ln|tar|zip|unzip|gzip|gunzip)/,
  /^\s*(?:\$\s+)?(?:sudo\s+)?(?:cat|head|tail|less|more|grep|rg|find|fd|wc|sort|uniq|awk|sed|cut|tr)/,
  /^\s*(?:\$\s+)?(?:sudo\s+)?(?:ls|dir|pwd|cd|echo|printf|export|source|\.)\s/,
  /^\s*(?:\$\s+)?(?:sudo\s+)?(?:kill|pkill|killall|taskkill|ps|top|htop)\s/,

  // Git commands
  /^\s*(?:\$\s+)?git\s+(?:add|commit|push|pull|clone|checkout|branch|merge|rebase|reset|stash|diff|log|status|remote|fetch|cherry-pick|tag|show|describe|rev-parse)/,

  // Node/npm/yarn/pnpm
  /^\s*(?:\$\s+)?(?:node|npm|npx|yarn|pnpm|tsx|ts-node)\s/,

  // Python
  /^\s*(?:\$\s+)?(?:python|python3|pip|pip3|pipenv|poetry)\s/,

  // Docker
  /^\s*(?:\$\s+)?(?:docker|docker-compose|podman)\s/,

  // PM2
  /^\s*(?:\$\s+)?pm2\s+(?:start|stop|restart|delete|reload|status|list|logs|describe|jlist|monit|save|dump)/,

  // Database commands
  /^\s*(?:\$\s+)?(?:sqlite3|mysql|psql|mongosh|redis-cli)\s/,

  // System administration
  /^\s*(?:\$\s+)?(?:systemctl|service|sc|net\s+(?:start|stop)|iptables|netsh|reg)\s/,
  /^\s*(?:\$\s+)?(?:apt|apt-get|yum|dnf|brew|choco|winget|pacman)\s+(?:install|remove|update|upgrade)/,

  // File write operations via shell
  /^\s*(?:\$\s+)?(?:tee|dd|mkfs|fdisk|mount|umount)\s/,

  // Windows commands
  /^\s*(?:\$\s+)?(?:del|rd|rmdir|copy|xcopy|robocopy|move|ren|rename|type|where|tasklist|taskkill|systeminfo|ipconfig|netstat|format|shutdown|reboot)\s/,

  // Network tools
  /^\s*(?:\$\s+)?(?:curl|wget|ssh|scp|rsync|ftp|sftp|nc|ncat|netcat|nmap|ping|nslookup|dig|tracert|traceroute)\s/,

  // SQL statements (inline or piped)
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\s/i,

  // fs.writeFile / fs.readFile (in Node context)
  /(?:fs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rename|renameSync|rmdir|rmdirSync|rm|rmSync|mkdir|mkdirSync|copyFile|copyFileSync))/,

  // PowerShell cmdlets
  /^\s*(?:New-Item|Remove-Item|Copy-Item|Move-Item|Set-Content|Add-Content|Clear-Content|Get-Content|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Stop-Process)\s/i,

  // nohup / background commands
  /^\s*(?:\$\s+)?nohup\s/,
];

// ── Fenced code block patterns ──────────────────────────────────────

/** Regex to extract commands from markdown fenced code blocks. */
const FENCED_BLOCK_REGEX = /```(?:bash|sh|shell|zsh|cmd|powershell|pwsh|sql|terminal|console)?\n([\s\S]*?)```/g;

/** Regex for inline code that looks executable. */
const INLINE_CODE_REGEX = /`([^`]{4,})`/g;

// ── CommandValidator class ──────────────────────────────────────────

export class CommandValidator {
  /**
   * Parse LLM output text and extract all executable commands.
   *
   * Detection strategy:
   *   1. Extract commands from fenced code blocks (```bash ... ```)
   *   2. Check each line for command-like patterns
   *   3. Extract inline code that matches command patterns
   *   4. De-duplicate and return unique commands
   */
  extractCommands(text: string): DetectedCommand[] {
    const commands: DetectedCommand[] = [];
    const seen = new Set<string>();

    // 1. Fenced code blocks -- highest priority
    FENCED_BLOCK_REGEX.lastIndex = 0;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = FENCED_BLOCK_REGEX.exec(text)) !== null) {
      const blockContent = blockMatch[1].trim();
      const lines = blockContent.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

        // Strip leading $ or > prompt characters
        const cleaned = trimmed.replace(/^\s*(?:\$|>)\s+/, '');
        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned);
          commands.push({
            command: cleaned,
            source: 'fenced-block',
            raw: line,
          });
        }
      }
    }

    // 2. Line-by-line scan for command patterns outside code blocks
    //    (strip out code blocks first so we don't double-count)
    const stripped = text.replace(/```[\s\S]*?```/g, '');
    const lines = stripped.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

      if (this.looksLikeCommand(trimmed)) {
        const cleaned = trimmed.replace(/^\s*(?:\$|>)\s+/, '');
        if (cleaned && !seen.has(cleaned)) {
          seen.add(cleaned);
          commands.push({
            command: cleaned,
            source: 'inline',
            raw: line,
          });
        }
      }
    }

    // 3. Inline code backticks
    INLINE_CODE_REGEX.lastIndex = 0;
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = INLINE_CODE_REGEX.exec(stripped)) !== null) {
      const code = inlineMatch[1].trim();
      if (this.looksLikeCommand(code) && !seen.has(code)) {
        seen.add(code);
        commands.push({
          command: code,
          source: 'inline-code',
          raw: inlineMatch[0],
        });
      }
    }

    return commands;
  }

  /**
   * Check if a string looks like an executable command.
   */
  looksLikeCommand(text: string): boolean {
    const stripped = text.replace(/^\s*(?:\$|>)\s+/, '').trim();
    return COMMAND_INDICATORS.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(stripped);
    });
  }
}

// ── Factory ─────────────────────────────────────────────────────────

export function createCommandValidator(): CommandValidator {
  return new CommandValidator();
}
