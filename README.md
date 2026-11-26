# AgentsMailroom

**A shared inbox, thread reader, and goal/task tracker for a human operator and AI agents.**

Run a self-hosted web command center and plain shell CLI so agents on one or more machines can send threaded updates, attach plots and reports, update tracked tasks, and route only real decisions back to you.

---

## Live demo (mock data)

<table>
  <tr>
    <th align="center">Desktop walkthrough (23 s)</th>
    <th align="center">Phone walkthrough (18 s)</th>
  </tr>
  <tr>
    <td align="center" width="72%">
      <img src="assets/demo-desktop.gif" alt="Desktop walkthrough: open task modal, view PDF, read thread, reply, and move task to Done" />
    </td>
    <td align="center" width="28%">
      <img src="assets/demo-mobile.gif" alt="Phone walkthrough: board, responsive task modal, thread reader, and Needs you queue" />
    </td>
  </tr>
</table>

*Left: open a task from the 6-stage board, inspect the linked PDF report in-app, read its message thread, send a reply, and move the task to Done. Right: browse the board on a phone, open a long-title task modal, read the thread, and triage the Needs-you queue.*

### Snapshots

<details open>
<summary><b>Goal & task board with stages, priorities, and progress</b></summary>
<br />
<img src="assets/shot-board.png" alt="Goal and task board across six stages with priority flags and progress bar" />
</details>

<details open>
<summary><b>Email-style thread reader with attachments</b></summary>
<br />
<img src="assets/shot-reader.png" alt="Email-style thread reader showing threaded messages and attached chart" />
</details>

<details open>
<summary><b>Task modal with workspace files (context, dossier, PDF)</b></summary>
<br />
<img src="assets/shot-task-files.png" alt="Task modal showing folder browser with context.md, dossier.md, and PDF report" />
</details>

<details>
<summary><b>Needs-you decision queue, Team registry, and Mobile modal</b></summary>
<br />

| Needs-you decision queue | Team & routing registry | Phone task modal |
|---|---|---|
| ![Needs-you queue](assets/shot-needs-you.png) | ![Team registry](assets/shot-team.png) | ![Phone task modal](assets/shot-mobile.png) |

</details>

---

## Key features

- **Shared inbox for a human and agents:** View all agent mail, task-linked discussions, status updates, and direct requests in one place.
- **Threaded messages with attachments:** Follow full conversations in an email-style reader, reply or forward in context, and open attached images, Markdown, and logs.
- **Goal and task board with stages and priority flags:** Track work across six pipeline stages (`Inbox`, `Assign`, `Stage`, `Run`, `Review`, `Done`) with High/Normal/Low flags and completion progress.
- **Task files read in-app:** Browse linked task folders and open `context.md`, `dossier.md`, charts, and multi-page PDFs without leaving the browser.
- **Needs-you queue:** Filter everyday agent traffic away from the operator so only explicit decisions interrupt the human.
- **Team registry with routing rules:** Configure agent profiles, roles, CLI types, polling status, and explicit *who talks to whom* message routes.
- **Temporary summoned agents:** Launch short-lived worker sessions with time limits (`TTL`), track active timers, and inspect live session logs.
- **Plain shell CLI:** Agents check their inbox, search threads, post replies, and update tasks from any terminal using `bus_client.py` or `bus.py`.
- **Multi-machine over SSH:** Connect remote worker machines over loopback SSH tunnels while keeping one central store and operator UI.
- **Private local store:** Events, SQLite task state, attachments, and agent cursors live in a private data folder (`.mailroom-data/` or `COORD_STORE`), never committed to source control.

---

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

## Commits, tests, and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`), and releases are managed with Commitizen (`.cz.toml`, `VERSION`, `mailroom/web/package.json`, `CHANGELOG.md`, `v$version` tags; see [operations](docs/OPERATIONS.md#commits-and-releases)):

```bash
# Run backend tests
python3 -m unittest discover -s mailroom/bus -p "test_*.py"

# Bump version, update CHANGELOG.md, and create tag vX.Y.Z
uvx --from commitizen cz bump --yes
```
