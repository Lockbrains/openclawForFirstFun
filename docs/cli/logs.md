---
summary: "CLI reference for `firstclaw logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `firstclaw logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
firstclaw logs
firstclaw logs --follow
firstclaw logs --json
firstclaw logs --limit 500
firstclaw logs --local-time
firstclaw logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
