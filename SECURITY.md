# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in PMAOS, please report it responsibly.

**Do NOT open a public issue.** Instead, email security concerns to the maintainers or use GitHub's private vulnerability reporting feature.

We aim to acknowledge reports within 48 hours and provide a fix or mitigation within 7 days for critical issues.

## Security Architecture

PMAOS uses a defense-in-depth model with seven layers:

### 1. Paladin Policy Engine

The first line of defense. Every bash command, file write, and API call passes through Paladin before execution.

- **Command allowlisting**: Only pre-approved command prefixes execute
- **Blocked patterns**: Dangerous commands (rm -rf, sudo, eval, pipe-to-shell) are always rejected
- **File access control**: Write permissions scoped to vault, workspace, and store directories
- **Rate limiting**: Configurable limits on bash commands, file writes, and API calls per minute
- **Approval gates**: Sensitive operations require owner approval via Telegram with timeout
- **Injection detection**: Prompt injection scoring with configurable thresholds

All configurable rules live in `config/policy.yaml` and hot-reload on file change.

### 2. Prime Directives

Hardcoded safety rules in `src/prime-directives.ts` that cannot be overridden by configuration, policy files, or prompt content. These are the non-negotiable boundaries.

### 3. Prompt Sanitization

- 30+ injection pattern detections across 6 categories
- Homoglyph (lookalike character) detection and normalization
- Base64-encoded payload detection
- Every inbound message is scored before processing

### 4. Content Quarantine

Untrusted content (web scrapes, file uploads, external API responses) goes through dual-LLM verification before being trusted. Content is wrapped with boundary markers to prevent injection via external data.

### 5. Secret Management

- All API keys stored in age-encrypted `.env.age` files (AES-256)
- Zero plaintext keys on disk when encryption is enabled
- Secret substitution replaces keys with placeholders before content reaches the AI model
- Key rotation tracking with age alerts

### 6. Cedar ABAC Policies

Attribute-based access control for fine-grained permission management. Policies define what each agent can and cannot do based on role, resource type, and context.

### 7. Namespace Isolation

Each agent operates in its own memory namespace. Cross-agent memory access requires explicit use of the shared namespace. Prevents information leakage between agents with different trust levels.

## Environment Hardening

### Recommended Setup

- Run on a dedicated machine or VM (not shared hosting)
- Use a non-root user with scoped sudo permissions
- Enable age encryption for all .env files: `bash scripts/encrypt-env.sh`
- Set a strong `PALADIN_APPROVAL_TOKEN` in your .env
- Review `config/policy.yaml` and tighten allowlists for your use case
- Use Telegram chat ID restrictions to limit who can interact with your bot

### Network

- Paladin binds to `127.0.0.1` only (never exposed to the network)
- The dashboard should be behind authentication and ideally a reverse proxy
- No ports need to be publicly exposed unless you're using webhook-based messaging

### Dependencies

- Run `npm audit` regularly to check for known vulnerabilities
- The project uses `.npmrc` with security hardening (ignore-scripts, strict-ssl)
- Third-party skills are scanned with YARA and behavioral analysis before installation via `scripts/scan-skill.sh`

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Scope

The following are in scope for security reports:

- Authentication or authorization bypasses
- Prompt injection that circumvents Paladin or prime directives
- Secret exposure (API keys, tokens, credentials in logs or responses)
- Path traversal or file access outside allowed directories
- Remote code execution
- Cross-agent privilege escalation
- Memory namespace isolation bypasses

The following are out of scope:

- Vulnerabilities in upstream dependencies (report to the dependency maintainer)
- Social engineering attacks against the bot operator
- Denial of service via rate limiting exhaustion (configurable, not a code bug)
- Issues requiring physical access to the host machine
