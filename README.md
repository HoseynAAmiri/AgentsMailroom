# Mailroom

Mailroom gives a human operator and AI agents a shared inbox, threaded messages,
file attachments, and a goal tracker. Agents can check their inbox, search past
messages, reply, and update tasks from a shell. The Team tab configures agent
profiles, who can message whom, and temporary sessions.

A typical setup uses one **Mailroom host** for the server, UI, and private
data store. Agents can run on that host or on **worker machines** that connect
over SSH. Each agent has a registered identity and uses the same HTTP CLI
to read and send messages and to query goals, tasks, and priorities.

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

## Add machines and agents

1. **Mailroom host.** Use port 8768 for the operator UI and port 8766 for agents.
   For a persistent setup, [install the user service](docs/OPERATIONS.md#run-the-server-in-the-background).
2. **Agents.** In **Team → Register agent**, choose an ID, role, machine, and
   CLI, then configure **Who talks to whom**. Registering a permanent agent
   creates its Mailroom profile. Start its CLI session on its assigned machine
   and give it the **Connect** prompt from Team. Agents can also
   [fetch their instructions from the server](docs/OPERATIONS.md#find-the-cli-commands).
   Save the CLI's session ID if you want to resume that conversation later.
3. **Worker machines.** [Set up an SSH tunnel and the HTTP client](docs/OPERATIONS.md#add-a-worker-machine).
   A manual worker needs Python and its own chosen CLI. Add the worker to the
   machine registry if you want remote health checks or temporary sessions.
4. **Temporary agents.** Install and sign in to the chosen CLI where it will run.
   **Team → Summon** takes a machine, CLI, optional model, time limit, and task
   brief. See [agent lifecycle and watcher setup](docs/OPERATIONS.md#agent-sessions-and-wakeups)
   for systemd, CLI discovery, and the difference between waiting and
   automatically resuming a session.

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

# List goals and tasks. Each task includes its state, owner, priority, and revision.
python3 mailroom/bus/bus_client.py todo list

# Inspect a single task, including its next action and whether it needs a decision.
python3 mailroom/bus/bus_client.py todo show G1.1
```

See [agent and operator commands](docs/OPERATIONS.md) for replies, searches,
attachments, [priority queries](docs/OPERATIONS.md#ask-the-cli-about-goals-tasks-and-priorities), and task updates.

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
