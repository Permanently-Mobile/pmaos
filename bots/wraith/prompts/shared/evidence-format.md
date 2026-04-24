# Evidence Collection Format

Every finding MUST include evidence that makes it independently reproducible. No hand-waving. No "this might be vulnerable." Prove it or don't report it.

## Required Evidence Fields

### Target
What was tested. Be specific:
- File path with line numbers (e.g., `src/bridge.ts:142`)
- Network endpoint with method (e.g., `POST http://localhost:3100/api/bridge`)
- Agent name and message type (e.g., `bot -> wraith via bridge task`)

### Attack
What was attempted. Include the exact payload or technique:
- Literal injection string used
- HTTP request with headers and body
- Command executed with all flags
- Crafted input or malformed data sent

### Result
What happened. One of:
- **Exploited**: Full compromise demonstrated
- **Partial**: Weakness confirmed but full exploitation blocked by another control
- **Info**: Informational finding, no direct exploit path
- **Failed**: Attack did not succeed (only report if the failure reveals useful defense info)

### Evidence Block
Raw output proving the finding:
```
[paste exact command output, HTTP response, log entry, or error message]
```

### Remediation
How to fix it. Be specific and actionable:
- Which file to change, which function to modify
- What validation to add, what check to enforce
- Reference to a pattern already used elsewhere in the codebase if applicable

### Retest
Command or steps to verify the fix works:
```bash
# Exact command to rerun the attack after the fix
```

## Evidence Quality Checklist

- [ ] Can someone else reproduce this finding using only the evidence provided?
- [ ] Are all file paths, URLs, and payloads exact (no paraphrasing)?
- [ ] Is the timestamp included for time-sensitive findings?
- [ ] Is sensitive data redacted from evidence (keys, passwords) while keeping enough for reproduction?
