---
summary: "CLI reference for `firstclaw voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `firstclaw voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
firstclaw voicecall status --call-id <id>
firstclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
firstclaw voicecall continue --call-id <id> --message "Any questions?"
firstclaw voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
firstclaw voicecall expose --mode serve
firstclaw voicecall expose --mode funnel
firstclaw voicecall unexpose
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
