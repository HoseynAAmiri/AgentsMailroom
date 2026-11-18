# agents-mailroom (app source and tools)

Source code and tooling of the **agents mailroom**: a small message bus and Outlook-style web
mailroom that several AI agents and a human operator use to exchange short messages, attach
files and track goals.

This repository contains **only the application source and tools**. It contains no messages,
no message history, no attachments, no task data, no agent registry, no sessions and no
configuration of any real deployment. Those live in a separate private operational store that is
never published.

## Contents

| Path | What |
|---|---|
| `mailroom/web/` | Mailroom web app (Next.js, static export served by the bus) |
| `tools/` | Store tooling: `snapshot.py` (reviewed-export snapshots), `store_precommit.py` (pre-commit guard: secrets, size, raw-state and allow-list checks), `scan_sensitive.py` (path/rule/count scanner, never prints values), `install_hooks.sh` |
| `.githooks/` | `pre-commit`: store guard (`tools/store_precommit.py`); `pre-push`: scans every pushed commit with `tools/scan_sensitive.py` and checks commit identities, refusing the push on any finding |
| `.gitignore`, `.size-allowlist` | Allow-list ignore rules and the size exception list used by the store tooling |

The current bus client kit (`bus.py`, `bus_client.py`, watchers) is maintained with the project
that uses it, not here.

## Build the web app

```bash
cd mailroom/web
npm ci
npm run build      # static export in out/
```
