# Mailroom operations

## Agent commands

The HTTP client uses `http://127.0.0.1:8766`. Set `BUS_URL` if you changed the
agent port. The server also makes the client available at `/bus_client.py`.
On the server host, `python3 mailroom/bus/bus.py` offers a direct CLI against the
same store for local agents and operators.

```bash
# Replace e1 with the event ID returned by inbox.
python3 mailroom/bus/bus_client.py post --from worker --to coordinator \
  --in-reply-to e1 --task-id G1.1 --body "I reviewed the task."

# Search your sent and received messages without advancing the unread cursor.
python3 mailroom/bus/bus_client.py search --agent worker --q "starter" --task-id G1.1

# Wait for unread mail. This shell command can block for up to 90 seconds.
python3 mailroom/bus/bus_client.py wait --agent worker --timeout 90

# After handling the message, advance the cursor through that event ID.
python3 mailroom/bus/bus_client.py mark-seen --agent worker --event-id e1

# Replace 1 with the current revision from todo show G1.1.
python3 mailroom/bus/bus_client.py todo update G1.1 --agent worker --revision 1 --state doing
```

Use **Files** to upload notes, images, or PDFs. Reference an existing attachment
from an agent post with `--ref file:coordination/attachments/<name>`. This is an
attachment reference prefix. The files live in the store's `attachments/`.
For a file already in the shared workspace, use `--ref path:<relative-path>`.
The operator can link files and tag discussions from **Goals**. Task updates
use revisions to prevent one editor from overwriting another's changes.

## Optional CLI integrations

- Permanent agents can poll with `wait`, read with `inbox`, and mark handled
  messages seen. Each agent's launcher controls whether a shell wait can
  trigger a new turn.
- **Team → Summon** runs an installed, signed-in CLI using a Linux systemd
  user unit. The supported command presets appear in the form and include
  Codex, Claude Code, OpenCode, Cursor Agent, and Antigravity. Availability
  depends on the installed CLI, its supported flags, and account access. Start
  with the standard permission setting. You can stop temporary runs in **Team**.
- The optional one-shot Codex watcher can be scheduled in a user timer or cron
  where the installed Codex supports `queue --thread … --resume`. Use absolute
  paths and the same `COORD_STORE` as the server. Test with
  `python3 mailroom/bus/watch_inbox.py --agent worker --thread <session-id> --codex <path-to-codex> --dry-run`.
  Remove the flag to queue actual wakes. A queued wake leaves the cursor for the
  agent to advance once it handles the message.
- To let a trusted remote agent reach the bus, forward only the agent port
  through SSH. For example, run the following on the client, substituting your
  server account and host. The admin interface stays on the server.

  ```bash
  # Forward local port 8766 to the server's loopback agent port.
  ssh -N -L 127.0.0.1:8766:127.0.0.1:8766 user@server
  ```

Machine telemetry uses Linux process, disk, and memory facilities. A local Docker
daemon adds container telemetry when available. An optional managed remote
machine uses a `machines` entry in the private `bus/agents.json`, with
`id`, `label`, `kind: "ssh"`, `repo` (the path relative to the remote home),
and `tunnel_unit` (a user systemd unit running OpenSSH with `-R`). Stop writers
before editing that registry directly. The bus obtains the SSH target and
optional identity file from the unit's `ExecStart`.

## Operate the server

Restart the same `serve` command after an update. For background use, run it
under a systemd user service with the checkout as its working directory and the
same store environment. The service should start only after `init` and `build`
have succeeded. Use `BUS_DASHBOARD_DIR` to select a staged static export if you
deploy the UI separately from the source tree.
