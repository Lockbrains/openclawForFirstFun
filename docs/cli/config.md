---
summary: "CLI reference for `firstclaw config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `firstclaw config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `firstclaw configure`).

## Examples

```bash
firstclaw config get browser.executablePath
firstclaw config set browser.executablePath "/usr/bin/google-chrome"
firstclaw config set agents.defaults.heartbeat.every "2h"
firstclaw config set agents.list[0].tools.exec.node "node-id-or-name"
firstclaw config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
firstclaw config get agents.defaults.workspace
firstclaw config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
firstclaw config get agents.list
firstclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
firstclaw config set agents.defaults.heartbeat.every "0m"
firstclaw config set gateway.port 19001 --json
firstclaw config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
