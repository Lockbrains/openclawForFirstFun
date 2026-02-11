---
summary: "CLI reference for `firstclaw approvals` (exec approvals for gateway or node hosts)"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
title: "approvals"
---

# `firstclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**.
By default, commands target the local approvals file on disk. Use `--gateway` to target the gateway, or `--node` to target a specific node.

Related:

- Exec approvals: [Exec approvals](/tools/exec-approvals)
- Nodes: [Nodes](/nodes)

## Common commands

```bash
firstclaw approvals get
firstclaw approvals get --node <id|name|ip>
firstclaw approvals get --gateway
```

## Replace approvals from a file

```bash
firstclaw approvals set --file ./exec-approvals.json
firstclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
firstclaw approvals set --gateway --file ./exec-approvals.json
```

## Allowlist helpers

```bash
firstclaw approvals allowlist add "~/Projects/**/bin/rg"
firstclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
firstclaw approvals allowlist add --agent "*" "/usr/bin/uname"

firstclaw approvals allowlist remove "~/Projects/**/bin/rg"
```

## Notes

- `--node` uses the same resolver as `firstclaw nodes` (id, name, ip, or id prefix).
- `--agent` defaults to `"*"`, which applies to all agents.
- The node host must advertise `system.execApprovals.get/set` (macOS app or headless node host).
- Approvals files are stored per host at `~/.firstclaw/exec-approvals.json`.
