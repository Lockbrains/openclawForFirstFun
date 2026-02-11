---
summary: "CLI reference for `firstclaw reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `firstclaw reset`

Reset local config/state (keeps the CLI installed).

```bash
firstclaw reset
firstclaw reset --dry-run
firstclaw reset --scope config+creds+sessions --yes --non-interactive
```
