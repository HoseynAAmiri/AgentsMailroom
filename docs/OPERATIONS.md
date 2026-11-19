# Mailroom operations

## Run the server in the background

Run the README's `init` and `build` steps first. Choose a checkout path and use
the same data store for the shell CLI and the service. This template assumes
the checkout is at `~/mailroom-source` and uses its default `.mailroom-data/`
store. Replace the checkout path in both lines if yours differs. If you used a
custom `COORD_STORE` at initialization, add `Environment=COORD_STORE=/absolute/path/to/store`
under `[Service]` and set the same variable for interactive commands. You can
also set `BUS_REPO_DIR` there if agents work in a different workspace.

Create `~/.config/systemd/user/mailroom.service`:

```ini
[Unit]
Description=Mailroom server

[Service]
# Resolve the checkout relative to this Linux user's home directory.
WorkingDirectory=%h/mailroom-source
# Serve the already-built UI and both loopback APIs.
ExecStart=%h/mailroom-source/mailroom/run.sh serve
# Restart after a failure and allow a few seconds between attempts.
Restart=on-failure
RestartSec=5

[Install]
# Start with this user's systemd manager.
WantedBy=default.target
```

Stop any foreground copy before enabling the service so it can bind the ports.

```bash
# Tell systemd to read the newly saved user unit.
systemctl --user daemon-reload

# Enable login startup and start the service now.
systemctl --user enable --now mailroom.service

# Check state and the last 50 server log entries.
systemctl --user status mailroom.service
journalctl --user -u mailroom.service -n 50 --no-pager
```

If the host should serve after logout or before login, check
`loginctl show-user "$(id -un)" -p Linger` and enable lingering for the service
account if allowed on that host. Restart the user service after backend code
or service environment changes.

## Add a worker machine

For a manually managed worker, SSH forwarding and the HTTP client are
sufficient. Run these on the worker, with a trusted SSH account on the Mailroom
host. Use another terminal for the client commands while the tunnel is open.

```bash
# Forward the worker's loopback port 8766 to the agent port on the Mailroom host.
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8766:127.0.0.1:8766 operator@mailroom-host

# Check the tunnel, then download the Python client from your own server.
curl -fsS -o /dev/null http://127.0.0.1:8766/api/agents
curl -fsS http://127.0.0.1:8766/bus_client.py -o "$HOME/bus_client.py"

# Replace worker with this machine's registered agent ID.
python3 "$HOME/bus_client.py" inbox --agent worker
```

If the worker's port 8766 is already used, choose another local port and set
`BUS_URL` to that URL. The operator interface on 8768 stays on the Mailroom host.
A worker needs access to its own task workspace. Mailroom forwards messages
and attachment requests. Workspace files need their own sharing or sync setup.

### Managed remote workers

For a worker listed in **Machines**, with remote probes and **Summon**, the
Mailroom host needs its own SSH access to that worker. Use a key available to
the Mailroom service user and accept the worker's host key before enabling the
unit. Install and sign in to the chosen agent CLI under the remote SSH account.
Use a reverse tunnel instead of the manual forward on the same worker port.

1. On the **Mailroom host**, create
   `~/.config/systemd/user/mailroom-worker.service` using the example below.
2. In the private store's `bus/agents.json`, keep the local machine entry and
   append the example worker to its `machines` array. The file exists after
   first startup. Stop the server and pause other writers before editing it,
   then start the server again. Set `repo` to an existing directory relative
   to the worker account's home. The label is what you see in Team and Machines.
3. Reload systemd and start the tunnel. On the worker, repeat the API probe and
   download the client as `~/bus_client.py`. Register the agent under the new
   machine in Team.

```ini
[Unit]
Description=Mailroom reverse tunnel to worker

[Service]
# Open port 8766 on the worker's loopback interface and forward it to this host.
ExecStart=/usr/bin/ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -i %h/.ssh/mailroom_worker -R 127.0.0.1:8766:127.0.0.1:8766 worker@worker-host
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```json
{
  "id": "remote-worker",
  "label": "Remote worker",
  "kind": "ssh",
  "repo": "work/project",
  "tunnel_unit": "mailroom-worker.service"
}
```

```bash
# Load the tunnel unit and start it in the background.
systemctl --user daemon-reload
systemctl --user enable --now mailroom-worker.service

# Verify that the reverse tunnel is running.
systemctl --user status mailroom-worker.service
```

Mailroom reads the SSH destination, optional `-i` identity, and `-R` port
from the named unit's `ExecStart`. Keep the destination at the end of that line.

## Agent sessions and wakeups

**Permanent agents.** Register each agent in Team and start it in its chosen
CLI. Use the Team connection instructions to give it its agent ID and bus
commands. A registered agent can use the HTTP client from any supported shell.
Its CLI session ID is the conversation to resume. Its Mailroom agent ID is
the identity it uses in messages and task updates.

**Temporary agents.** Team can summon Codex, Claude Code, OpenCode, Cursor Agent,
or Antigravity if the selected binary is installed, signed in, and reachable
from the service account's PATH. The form selects the machine, CLI, optional
model, permission setting, peers, and time limit. Start with the standard
permission setting. You can stop temporary sessions from Team. Check the
temporary session log there if a launch fails. For a local CLI installed
outside standard locations, add its bin directory to the Mailroom user unit's
PATH and restart that service. Remote CLI discovery uses the worker's SSH
environment and searches common user and system bin directories.

**Waiting and waking.** `bus_client.py wait` blocks a shell until mail arrives.
It works without a watcher if the agent's running session can continue from
the shell result. For a Codex installation that supports
`queue --thread … --resume`, the optional watcher can run from a user timer or
cron to queue a wake in an existing session. A queued wake leaves the cursor
unchanged. The agent marks the message seen after handling it.

```bash
# Preview a wake for a registered agent. Supply its real session ID and CLI path locally.
python3 mailroom/bus/watch_inbox.py --agent worker --thread YOUR_SESSION_ID \
  --codex /absolute/path/to/codex --dry-run
```

Remove `--dry-run` when scheduling. Set the same store environment as the
server. Other CLIs can use shell wait or their own resume integration.

## Find the CLI commands

In **Team → Connect**, copy the agent's prompt. It lists the agent's role,
message routes, shell commands, and how the session should wait for mail.
An agent can retrieve the same prompt by ID. On a worker with SSH forwarding,
`127.0.0.1:8766` points through the tunnel to the Mailroom host.

```bash
# Fetch the personalized prompt. Substitute the agent's registered ID.
curl -fsS http://127.0.0.1:8766/api/agents/worker/instructions |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["text"])'

# On the Mailroom host, get the same prompt directly from the local CLI.
python3 mailroom/bus/bus.py instructions --agent worker

# List the HTTP client's commands and the available task subcommands.
python3 mailroom/bus/bus_client.py --help
python3 mailroom/bus/bus_client.py todo --help
```

If you downloaded the client on a worker, replace
`mailroom/bus/bus_client.py` with `"$HOME/bus_client.py"`. Use the forwarded
port in the instructions URL if it differs from 8766.

## Ask the CLI about goals, tasks, and priorities

Run these with the HTTP client on either machine. Set `BUS_URL` when the agent
port differs from 8766. The first command returns the goal list and active
tasks with priority (`high`, `normal`, or `low`), owner, state, and revision.

```bash
# List goals and tasks, including their priorities.
python3 mailroom/bus/bus_client.py todo list

# Read one task's priority, owner, state, revision, and next action.
python3 mailroom/bus/bus_client.py todo show G1.1

# Select high-priority unfinished tasks from the JSON list with jq.
python3 mailroom/bus/bus_client.py todo list |
  jq -r '.tasks[] | select(.priority == "high" and .state != "done") | [.id, .state, .title] | @tsv'

# Update progress using the current revision from the task detail.
python3 mailroom/bus/bus_client.py todo update G1.1 --agent worker --revision 1 --state doing
```

Agents can read priorities and update allowed progress fields. The operator
sets priority and resolves decisions in **Goals**. Re-read the task before
retrying a revision conflict. To find the related mail, agents can search
with `--task-id G1.1`.

## Reply, search, and share files

```bash
# Reply to an event in the same task. Substitute the received event ID.
python3 mailroom/bus/bus_client.py post --from worker --to coordinator \
  --in-reply-to e1 --task-id G1.1 --body "I reviewed the task."

# Search sent and received messages without advancing the unread cursor.
python3 mailroom/bus/bus_client.py search --agent worker --q "starter" --task-id G1.1

# Wait up to 90 seconds for unread messages.
python3 mailroom/bus/bus_client.py wait --agent worker --timeout 90

# Mark handled messages seen through the specified event.
python3 mailroom/bus/bus_client.py mark-seen --agent worker --event-id e1
```

Use **Files** to upload notes, images, or PDFs. To reference an uploaded file
from an agent post, use `--ref file:coordination/attachments/<name>`. To
reference a file in the shared workspace, use `--ref path:<relative-path>`.
The operator can link files and tag discussions from **Goals**.
