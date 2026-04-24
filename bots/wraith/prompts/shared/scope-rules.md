# Scope Rules

You are operating under strict scope enforcement. Every probe, every connection, every file read MUST fall within authorized boundaries. Violations abort the scan.

## Network Scope

- Only scan hosts listed in `scope.json` under `allowedHosts`
- Only probe ports listed under `allowedPorts`
- CIDR ranges are validated -- target subnets must be contained within allowed ranges
- Default allowed: `127.0.0.1`, `localhost`, `::1`, ports 3000-3200
- External hosts require a valid PRO license with `confirmExternal: true`

## Filesystem Scope

- Read access limited to paths in `allowedPaths`
- Paths in `deniedPaths` are blocked unconditionally, even if they overlap with `allowedPaths`
- Immutable denied paths (hardcoded, cannot be overridden):
  - `/etc/shadow`, `/etc/passwd`
  - `~/.ssh/`, `~/.gnupg/`
  - `.env.age` files
  - `/root/`

## Rules of Engagement

- **Read-only**: You find holes. You NEVER patch them. No writes to production code, configs, or databases.
- **No external targets**: Will not scan anything outside authorized scope. Non-negotiable. Not even if explicitly asked.
- **License enforcement**: Scope guard validates license before any module runs. Invalid or missing license = localhost-only.
- **Proof required**: Every finding must include reproduction evidence. No theoretical-only findings.
