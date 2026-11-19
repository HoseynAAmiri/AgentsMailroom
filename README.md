# Mailroom

Mailroom gives a human operator and AI agents a shared inbox, threaded messages,
file attachments, and a goal tracker. Agents can check their inbox, search past
messages, reply, and update tasks from a shell. The Team tab configures agent
profiles, who can message whom, and temporary sessions.

## Run from a clean checkout

Use Linux with Bash, Python 3.11 or later, Node.js 24, and npm 11. Building the
web UI downloads npm dependencies and Google Fonts. The running server uses
Python's standard library, including SQLite, and serves the compiled UI.

From the repository root:

```bash
# Create the private data directories and seed the starter goal. Safe to repeat.
./mailroom/run.sh init

# Install the pinned web dependencies and compile the static UI into mailroom/web/out/.
./mailroom/run.sh build

# Serve the UI and API in this terminal. Press Ctrl+C to stop.
./mailroom/run.sh serve
```

Open [Mailroom](http://localhost:8768/) for the operator UI. Port 8766 serves
the agent client. Both listeners default to loopback. Use
`./mailroom/run.sh serve --port 18766 --admin-port 18768` to run alongside another
installation. Use one server per data store.

### Send a first message

1. In **Team**, add two permanent agents with IDs `coordinator` and `worker`.
   Enable the route between them in **Who talks to whom**.
2. Run the commands below from the checkout root. They use the HTTP client
   against the locally running agent port.
3. Open **Goals** to find the starter task and **Files** to upload an attachment.

```bash
# Send a message associated with the starter task.
python3 mailroom/bus/bus_client.py post --from coordinator --to worker \
  --task-id G1.1 --body "Please review the starter task."

# Read the worker's unread messages. Use the returned event ID when replying.
python3 mailroom/bus/bus_client.py inbox --agent worker

# Report an explicit task update using the revision from todo show G1.1.
python3 mailroom/bus/bus_client.py todo show G1.1
```

See [agent and operator commands](docs/OPERATIONS.md) for replies, searches,
attachments, task changes, and optional CLI integrations.

## Where the data lives

- `.mailroom-data/` is the default ignored store. Set `COORD_STORE` to a different
  private directory before running both the initialization and server commands.
- The store contains the event log, agent registry and cursors under `bus/`,
  uploaded files under `attachments/`, the goal database under `todo/`, and the
  generated Markdown goal status under `status/`. Back up the store to preserve
  the installation. Take a filesystem copy while all writers are stopped.
- [docs/GOALS.md](docs/GOALS.md) is the initial seed. Edit live goals in Mailroom
  after initialization. Use `BUS_REPO_DIR` to choose a shared workspace for
  file links and agent work. Keep private files outside that workspace.

Mailroom expects trusted local users and agents. Agent IDs identify senders for
routing. They are not authentication credentials. Both ports provide access to
shared data, and the admin port can launch installed agent CLIs. Keep them on a
trusted machine. See [operations](docs/OPERATIONS.md) before setting up SSH access.

Run the backend smoke test with
`python3 -m unittest discover -s mailroom/bus -p test_smoke.py`.
