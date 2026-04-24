# Severity Classification Guide

Assign severity based on real-world impact, not theoretical possibility. A finding is only as severe as its actual exploitability in context.

## CRITICAL

Immediate, exploitable threat with direct impact on system integrity, data confidentiality, or availability.

**Examples:**
- Remote code execution on any PMAOS service
- Credential exposure (API keys, DB passwords, SSH keys) in accessible locations
- Agent impersonation allowing unauthorized command execution
- Full bypass of scope enforcement or safety controls
- Bridge message forgery leading to arbitrary agent dispatch

**Response:** Immediate escalation. Blocks all other work until patched.

## HIGH

Significant vulnerability that could lead to compromise with minimal attacker effort.

**Examples:**
- SQL injection in bridge or database queries
- Path traversal allowing reads outside authorized scope
- Prompt injection that bypasses guardrails or safety filters
- Missing authentication on internal API endpoints
- Privilege escalation from unprivileged to admin context

**Response:** Escalate within the current scan cycle. Patch within 24 hours.

## MEDIUM

Exploitable weakness requiring specific conditions or chaining with other findings.

**Examples:**
- Missing rate limiting on sensitive endpoints
- Weak input validation that could be part of an attack chain
- Information disclosure of internal architecture or paths
- Insecure default configurations
- Missing security headers (CSP, HSTS, X-Frame-Options)

**Response:** Logged to scan report. Queued for next maintenance cycle.

## LOW

Minor weakness with limited practical impact.

**Examples:**
- Verbose error messages exposing stack traces
- Missing best-practice security headers on non-sensitive endpoints
- Outdated dependencies with no known exploitable CVE in our usage
- Minor information leaks (server version strings, technology fingerprints)

**Response:** Logged to scan report. Fix when convenient.

## INFO

Observations, hardening suggestions, or positive security confirmations.

**Examples:**
- Defense-in-depth recommendations
- Security control confirmed working as expected
- Attack surface documentation updates
- Configuration optimization suggestions

**Response:** Logged to scan report only. No action required.

## Classification Rules

1. **Real impact over theoretical risk.** If you cannot demonstrate exploitation, it is not CRITICAL.
2. **Context matters.** An SQL injection on an internal-only endpoint with authentication is HIGH, not CRITICAL.
3. **Chaining raises severity.** Two MEDIUM findings that chain into RCE become CRITICAL.
4. **False positives get INFO.** If a tool flags something but manual verification shows it is not exploitable, log as INFO with explanation.
5. **When in doubt, go one level higher.** Better to over-report and let the owner triage down than to miss a real threat.
