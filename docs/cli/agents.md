---
summary: "CLI reference for `firstclaw agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
---

# `firstclaw agents`

Manage isolated agents (workspaces + auth + routing).

Related:

- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
firstclaw agents list
firstclaw agents add work --workspace ~/.firstclaw/workspace-work
firstclaw agents set-identity --workspace ~/.firstclaw/workspace --from-identity
firstclaw agents set-identity --agent main --avatar avatars/firstclaw.png
firstclaw agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.firstclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
firstclaw agents set-identity --workspace ~/.firstclaw/workspace --from-identity
```

Override fields explicitly:

```bash
firstclaw agents set-identity --agent main --name "FirstClaw" --emoji "🦞" --avatar avatars/firstclaw.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "FirstClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/firstclaw.png",
        },
      },
    ],
  },
}
```
