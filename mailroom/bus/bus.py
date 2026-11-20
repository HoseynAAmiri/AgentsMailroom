#!/usr/bin/env python3
"""Append-only agent message bus + Mission control (mailroom) server.

Agents post/read structured events here. The web UI only visualizes this store and
writes USER's messages, USER's mailbox state and the team registry through the API.
Terminal stdout is never the source of truth for agent<->agent speech.

Supports the existing CLI commands, event fields,
same HTTP endpoints. Additions: cc, subject, in_reply_to on events; data-driven routes
in agents.json; USER mailbox state (read/flag/soft delete); temporary agents summoned
as timed systemd user units.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left, bisect_right
import gzip
import fcntl
import ipaddress
import io
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from functools import lru_cache
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, quote, unquote, urlparse

BUS_PY = Path(__file__).resolve()
if str(BUS_PY.parent) not in sys.path:
    sys.path.insert(0, str(BUS_PY.parent))
from coord_store import resolve_store  # noqa: E402  (store locator shared with the watchers)

# The code (this file) is the Mailroom Python runtime; the data
# lives in the agents-mailroom store (COORD_STORE, config file, or ../agents_mailroom).
# The BUS_* variables still override single locations (tests, temporary agents).
STORE_DIR, STORE_SOURCE = resolve_store()
BUS_DIR = Path(os.environ.get("BUS_DATA_DIR") or STORE_DIR / "bus").resolve()
COORD_DIR = Path(os.environ.get("BUS_COORD_DIR") or BUS_DIR.parent).resolve()
DASHBOARD_DIR = Path(os.environ.get("BUS_DASHBOARD_DIR") or COORD_DIR / "dashboard").resolve()
ATTACH_DIR = Path(os.environ.get("BUS_ATTACH_DIR") or COORD_DIR / "attachments").resolve()
APP_DIR = BUS_PY.parents[2]
REPO_DIR = Path(os.environ.get("BUS_REPO_DIR") or APP_DIR).resolve()
ATTACH_REF_PREFIX = "coordination/attachments/"
# Write ingress gate: while this file exists (maintenance window, cutover smoke tests) every
# HTTP write returns 503 and CLI writes exit 75. BUS_INGRESS_OVERRIDE=1 allows one controlled
# test write by the operator.
INGRESS_GATE = BUS_DIR / ".ingress_closed"
INGRESS_CLOSED_EXIT = 75


def ingress_closed() -> bool:
    return INGRESS_GATE.exists() and os.environ.get("BUS_INGRESS_OVERRIDE") != "1"


def logical_file(rel: str) -> tuple[Path, Path]:
    """Map a repo-relative ref to (file, allowed root). `coordination/attachments/...` refs keep
    their historical spelling but live in the store's attachments folder."""
    if rel.startswith(ATTACH_REF_PREFIX):
        return ATTACH_DIR / rel[len(ATTACH_REF_PREFIX):], ATTACH_DIR
    return REPO_DIR / rel, REPO_DIR


def viewable_path(path: Path, root: Path) -> bool:
    """Allow named attachments and workspace files outside private runtime state."""
    try:
        resolved = path.resolve()
        base = root.resolve()
        if not resolved.is_relative_to(base):
            return False
        rel = resolved.relative_to(base)
    except (ValueError, OSError):
        return False
    if any(part.startswith(".") for part in rel.parts):
        return False
    return base == ATTACH_DIR.resolve() or not resolved.is_relative_to(STORE_DIR.resolve())


AGENTS_PATH = BUS_DIR / "agents.json"
EVENTS_PATH = BUS_DIR / "events.jsonl"
SEEN_DIR = BUS_DIR / ".seen"
LOCK_PATH = BUS_DIR / ".lock"
USER_STATE_PATH = BUS_DIR / "user_state.json"
SESSIONS_DIR = BUS_DIR / "sessions"


def todo_store():
    from todo_store import TodoStore

    root = Path(os.environ.get("BUS_TODO_DIR") or COORD_DIR / "todo")
    # The reviewed roadmap seed stays in the repository; the generated live status is private
    # and is written into the store, never into the main checkout.
    status = Path(os.environ.get("BUS_GOALS_STATUS") or COORD_DIR / "status" / "GOALS_STATUS.md")
    status.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    roadmap = REPO_DIR / "docs" / "GOALS.md"
    if not roadmap.is_file() and (APP_DIR / "docs" / "GOALS.md").is_file():
        roadmap = APP_DIR / "docs" / "GOALS.md"
    return TodoStore(root / "tasks.sqlite3", roadmap, status)


def todo_last_event() -> int:
    with _EVENT_INDEX.lock:
        _EVENT_INDEX.refresh()
        return _EVENT_INDEX.max_id


def todo_mutation(values, *, admin: bool):
    from todo_store import TodoError, relative_file

    if not isinstance(values, dict):
        raise TodoError("Expected a JSON object")
    editor = values.get("agent") or ("user" if admin else None)
    if not isinstance(editor, str):
        raise TodoError("Agent ID is required", 403)
    registry = load_agents()
    agents = {row["id"]: row for row in registry["agents"]}
    if editor == "user" and not admin or editor != "user" and (editor not in agents or agent_ended(agents[editor])):
        raise TodoError("An active agent ID or the USER admin port is required", 403)
    if values.get("action") == "tag" and editor == "user":
        event_id = values.get("event_id")
        with _EVENT_INDEX.lock:
            _EVENT_INDEX.refresh()
            if not isinstance(event_id, str) or event_id not in _EVENT_INDEX.positions:
                raise TodoError("Unknown message ID", 404)
    if values.get("action") in ("link", "unlink"):
        path = relative_file(values.get("path"))
        if Path(path).suffix.lower() not in TEXT_EXT and Path(path).suffix.lower() not in MIME:
            raise TodoError("Use a file format supported by the Mailroom viewer")
        target, root = logical_file(path)
        if not viewable_path(target, root):
            raise TodoError("Use a workspace file or a Mailroom attachment")
        values = {**values, "path": path}
    store = todo_store()
    if not store.initialized():
        raise TodoError("Goal tracking has not been seeded", 503)
    return store.mutate(values, editor, set(agents))


@lru_cache(maxsize=1024)
def todo_file_tag(path: Path, mtime_ns: int, size: int) -> str | None:
    try:
        with path.open("rb") as stream:
            header = stream.read(4096).decode("utf-8", errors="replace")
    except OSError:
        return None
    front = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", header, re.S)
    match = re.search(r"^task_id:[ \t]*['\"]?(G[1-9]\d*\.[1-9]\d*)['\"]?[ \t]*\r?$",
                      front[1], re.M) if front else None
    return match[1] if match else None


@lru_cache(maxsize=2)
def todo_documents(window: int):
    files = []
    # Cache the path inventory briefly. Each changed file needs only its leading metadata.
    docs = REPO_DIR / "docs"
    paths = [(ATTACH_DIR / row["name"], f"coordination/attachments/{row['name']}", ATTACH_DIR)
             for row in attachments_list(limit=5000)]
    for directory, names, children in os.walk(docs):
        names[:] = [name for name in names if not name.startswith(".") and name != "archive"]
        paths.extend((path, path.relative_to(REPO_DIR).as_posix(), docs)
                     for child in children if child.endswith(".md") and not child.startswith(".")
                     and child != "GOALS_STATUS.md" for path in (Path(directory) / child,))
    for path, label, root in paths:
        try:
            if not viewable_path(path, root):
                continue
            stat = path.stat()
            task = todo_file_tag(path, stat.st_mtime_ns, stat.st_size) if path.suffix.lower() == ".md" else None
        except OSError:
            continue
        files.append((label, task, stat.st_mtime))
    return files


def todo_read(params, *, admin: bool):
    from todo_store import TodoError, relative_file

    store = todo_store()
    if not store.initialized():
        raise TodoError("Goal tracking has not been seeded", 503)
    if params.get("mail") == "1":
        return store.mail_index(include_tags=admin)
    if params.get("event_id") and admin:
        tags, _ = store.activity()
        key = params["event_id"]
        return {"override": key in tags, "task_id": tags.get(key)}
    data = store.listing(include_links=admin)
    item = params.get("id")
    if item is None:
        return data
    tasks = {task["id"]: task for task in data["tasks"]}
    try:
        offset = max(0, int(params.get("offset", "0")))
    except ValueError as exc:
        raise TodoError("offset must be an integer") from exc
    untagged = item == "untagged"
    if untagged and not admin:
        raise TodoError("Untagged triage requires USER", 403)
    if not untagged and item not in tasks:
        raise TodoError("Unknown active task", 404)
    if not admin:
        # Agent commands may retrieve task records. Evidence is available via the agent's own message search.
        return {"task": tasks[item]}
    tags, files = store.activity(item)
    with _EVENT_INDEX.lock:
        index = _EVENT_INDEX
        index.refresh()
        if untagged:
            first = bisect_right(index.event_numbers, data["cutover"])
            candidates = index.events[first:]
            rows = [event for event in reversed(candidates) if event["type"] != "agent.status"
                    and tags.get(event["id"], event.get("task_id")) not in tasks]
            inherited = [event for event in candidates if tags.get(event["id"], event.get("task_id")) in tasks]
        else:
            positions = set(index.by_task.get(item, ()))
            positions.update(index.positions[key] for key, target in tags.items() if target == item and key in index.positions)
            rows = [index.events[pos] for pos in sorted(positions, reverse=True)
                    if tags.get(index.events[pos]["id"], index.events[pos].get("task_id")) == item]
            inherited = rows
    linked = set(files)
    for event in inherited:
        for ref in event.get("refs") or ():
            if isinstance(ref, dict) and ref.get("kind") in {"file", "path"}:
                try:
                    linked.add(relative_file(ref.get("value")))
                except TodoError:
                    pass
    documents = todo_documents(int(time.monotonic() // 15))
    if untagged:
        linked.update(store.linked_paths())
        cutover_time = datetime.fromisoformat(data["cutover_time"]).timestamp()
        linked = {path for path, tag, mtime in documents
                  if mtime > cutover_time and tag not in tasks and path not in linked}
    else:
        linked.update(path for path, tag, _ in documents if tag == item)
    return {"task": tasks.get(item), "offset": offset, "total": len(rows),
            "events": [{"id": e["id"], "subject": e.get("subject"), "from": e["from"], "type": e["type"],
                        "task_id": e.get("task_id"), "ts": e["ts"], "excerpt": str(e.get("body") or "")[:160]}
                       for e in rows[offset:offset + 30]],
            "files": sorted(linked)[offset:offset + 30], "file_total": len(linked), "manual_files": files}


@contextmanager
def bus_lock():
    """Exclusive lock so concurrent agents never get duplicate ids or lose agents.json updates. Not reentrant."""
    LOCK_PATH.touch(exist_ok=True)
    with LOCK_PATH.open("r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


VALID_TYPES = {
    "message",
    "task.started",
    "task.blocked",
    "task.completed",
    "task.failed",
    "human.needed",
    "agent.status",
}

# The Team page controls message routes for each installation.
DEFAULT_LINKS: list[dict[str, str]] = []
TOOL_TO_CLI = {"claude": "claude", "codex": "codex", "antigravity": "agy", "agy": "agy", "cursor": "cursor-agent", "opencode": "opencode"}
TEMP_ENDED = {"expired", "stopped", "finished", "failed"}

# Non-interactive invocations, checked against each CLI's --help in the supported CLI configurations.
# {prompt} {repo} {model} {ttl_s} are filled in at summon time; "model" args are dropped when no model is given.
CLI_PRESETS: dict[str, dict[str, Any]] = {
    "claude": {
        "label": "Claude Code",
        "bin": "claude",
        "standard": ["claude", "-p", "{prompt}", "--allowedTools", "Bash(python3 {bus_py} *)", "Read", "Grep", "Glob"],
        "full": ["claude", "-p", "{prompt}", "--dangerously-skip-permissions"],
        "model": ["--model", "{model}"],
        "resume": "claude --resume {session}",
    },
    "codex": {
        "label": "Codex",
        "bin": "codex",
        "standard": ["codex", "exec", "-s", "workspace-write", "-C", "{repo}", "{prompt}"],
        "full": ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "-C", "{repo}", "{prompt}"],
        "model": ["-m", "{model}"],
        "resume": "codex resume {session}",
    },
    "cursor-agent": {
        "label": "Cursor Agent",
        "bin": "cursor-agent",
        "standard": ["cursor-agent", "-p", "--trust", "--workspace", "{repo}", "{prompt}"],
        "full": ["cursor-agent", "-p", "--trust", "--force", "--workspace", "{repo}", "{prompt}"],
        "model": ["--model", "{model}"],
        "resume": "cursor-agent --resume {session}",
    },
    "opencode": {
        "label": "OpenCode",
        "bin": "opencode",
        "standard": ["opencode", "run", "--dir", "{repo}", "{prompt}"],
        "full": ["opencode", "run", "--auto", "--dir", "{repo}", "{prompt}"],
        "model": ["-m", "{model}"],
        "resume": "opencode --session {session}",
    },
    "agy": {
        "label": "Antigravity",
        "bin": "agy",
        "standard": ["agy", "-p", "{prompt}", "--mode", "auto", "--print-timeout", "{ttl_s}s"],
        "full": ["agy", "-p", "{prompt}", "--dangerously-skip-permissions", "--print-timeout", "{ttl_s}s"],
        "model": ["--model", "{model}"],
        "resume": "agy --conversation {session}",
    },
}
# Standing role prompts. An agent's own role_prompt (Team page) overrides the preset text.
ROLE_PRESETS: dict[str, dict[str, str]] = {
    "orchestrator": {
        "label": "Orchestrator",
        "prompt": "You are the orchestrator and referee. Plan the work, split it into numbered tasks (task_id), assign them to the agents you may message, review their results against the evidence, decide, and raise human.needed to USER for anything that needs USER's decision. You run little yourself.",
    },
    "reviewer": {
        "label": "Reviewer",
        "prompt": "You are an on-call reviewer. Act only when the orchestrator or USER asks. Check claims against the repository and raw outputs, recompute key numbers independently, and answer with a verdict (supported / not supported / unclear) plus the evidence. Do not start runs.",
    },
    "worker": {
        "label": "Worker",
        "prompt": "You are an execution agent. Carry out the tasks assigned to you: runs, code, records. Post task.started when you begin, task.completed or task.failed with numbers and file references when done, and task.blocked when you need something. Follow the workspace rules in AGENTS.md if present.",
    },
    "researcher": {
        "label": "Researcher",
        "prompt": "You are a researcher. Answer the question in your brief from the repository, the literature and documentation. Cite sources (paths, URLs, DOIs). Put long findings in an attachment and post a short summary with the verdict.",
    },
    "auditor": {
        "label": "Auditor",
        "prompt": "You are an auditor. Read the assigned files, logs or results and list concrete problems (with file and line or event id) and what evidence would resolve each. Do not modify anything.",
    },
}
LISTENING_MIN = 15

DEFAULT_MACHINES = [
    {"id": "A", "label": "Local machine", "kind": "local", "note": "Runs the Mailroom server."},
]
REMOTE_PATH = "$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/snap/bin:$PATH"
PROBE_EVERY_S = 60
PUBLIC_PORT = 8766
_MACHINE_STATUS: dict[str, dict[str, Any]] = {}  # an agent that checked its inbox within this many minutes counts as listening

SUMMON_EST_GIB = 2.0  # estimate per temporary agent CLI process tree; replace with measured peaks in sessions/*.json
SUMMON_MEMORY_MAX_GIB = 6
MIN_AVAIL_AFTER_GIB = 6.0  # Preserve host memory for the operator and other jobs.
MAX_ACTIVE_TEMP = 3
MAX_TTL_MIN = 300


# ---------------------------------------------------------------- basics

def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def id_num(event_id: Any) -> int:
    m = re.match(r"e(\d+)$", str(event_id or ""))
    return int(m.group(1)) if m else 0


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def load_agents() -> dict[str, Any]:
    if not AGENTS_PATH.exists():
        return {"agents": []}
    return json.loads(AGENTS_PATH.read_text(encoding="utf-8"))


def save_agents(data: dict[str, Any]) -> None:
    write_json(AGENTS_PATH, data)


def get_links(data: dict[str, Any] | None = None) -> list[dict[str, str]]:
    data = data if data is not None else load_agents()
    links = data.get("links")
    return links if isinstance(links, list) else [dict(x) for x in DEFAULT_LINKS]


def find_agent(data: dict[str, Any], agent_id: str) -> dict[str, Any] | None:
    return next((a for a in data.get("agents", []) if a.get("id") == agent_id), None)


def agent_ended(agent: dict[str, Any] | None) -> bool:
    """Temporary agents stop being addressable once their timer ran out or they were stopped."""
    if not agent or agent.get("kind") != "temporary":
        return False
    if agent.get("state") in TEMP_ENDED:
        return True
    exp = parse_ts(agent.get("expires_at"))
    return bool(exp and exp < datetime.now(timezone.utc))


def ended_agent_message(agent: dict[str, Any]) -> str:
    state = agent.get("state")
    reason = {
        "failed": "its process failed",
        "finished": "its process has exited",
        "stopped": "it was stopped",
    }.get(state, "its time has ended")
    return f"{agent['id']} is unavailable: {reason}"


class EventIndex:
    """Incremental in-process view of the append-only, cross-process JSONL log.

    Only complete newline-terminated records advance the byte offset. A missing,
    replaced, shrunk, or same-size rewritten log resets both indexes and cursor.
    """

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.RLock()
        self._reset()

    def _reset(self) -> None:
        self.signature = None
        self.offset = 0
        self.epoch = secrets.token_hex(8)
        self.events: list[dict[str, Any]] = []
        self.event_numbers: list[int] = []
        self.positions: dict[str, int] = {}
        self.by_recipient: dict[str, list[int]] = {}
        self.by_participant: dict[str, list[int]] = {}
        self.by_task: dict[str, list[int]] = {}
        self.task_revision = 0
        self.max_id = 0
        self.task_cache: list[dict[str, Any]] | None = None

    @staticmethod
    def _signature(stat: os.stat_result) -> tuple[int, int, int, int, int]:
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    def refresh(self) -> None:
        # Call under lock. Fast path does a single stat for an unchanged file.
        try:
            stat = self._signature(self.path.stat())
            if stat == self.signature:
                return
            with self.path.open("rb") as stream:
                stat = self._signature(os.fstat(stream.fileno()))
                prev = self.signature
                if prev is not None and (stat[:2] != prev[:2] or stat[2] <= prev[2]):
                    self._reset()
                stream.seek(self.offset)
                while self.offset < stat[2]:
                    row = stream.readline(stat[2] - self.offset)
                    if not row.endswith(b"\n"):
                        break
                    if row.strip():
                        self._append(json.loads(row))
                    self.offset += len(row)
                self.signature = stat
        except FileNotFoundError:
            if self.signature is not None:
                self._reset()

    def _append(self, event: dict[str, Any]) -> None:
        pos = len(self.events)
        event_id = event.get("id")
        # Match the prior inbox/snapshot cursor's first occurrence on legacy data.
        if isinstance(event_id, str):
            self.positions.setdefault(event_id, pos)
            self.max_id = max(self.max_id, id_num(event_id))
        if event.get("type") != "agent.status":
            addressed = {r for r in recipients(event) if isinstance(r, str)}
            for agent in addressed:
                self.by_recipient.setdefault(agent, []).append(pos)
            sender = event.get("from")
            if isinstance(sender, str):
                addressed.add(sender)
            for agent in addressed:
                self.by_participant.setdefault(agent, []).append(pos)
        task_id = event.get("task_id")
        if isinstance(task_id, str) and task_id:
            self.by_task.setdefault(task_id, []).append(pos)
            self.task_revision += 1
            self.task_cache = None
        self.events.append(event)
        self.event_numbers.append(self.max_id)

    def inbox_positions(self, agent: str, seen: str, *, missing_seen_empty: bool) -> tuple[list[int], int]:
        # Call under lock. Legacy inbox and presence have different unknown-cursor behavior.
        positions = self.by_recipient.get(agent, [])
        if seen and seen not in self.positions and missing_seen_empty:
            return positions, len(positions)
        return positions, bisect_right(positions, self.positions.get(seen, -1))

    def delta(self, after: str | None, cursor: str | None = None) -> tuple[list[dict[str, Any]], bool, str | None, str]:
        # Call under lock. Keep the existing after=eNNN API and let opted-in clients detect log resets.
        pos = self.positions.get(after) if after else None
        if cursor:
            epoch, _, anchor = cursor.partition(":")
            pos = self.positions.get(anchor) if epoch == self.epoch and anchor else None
        last = self.events[-1]["id"] if self.events else None
        return self.events[pos + 1:] if pos is not None else self.events[:], pos is None, last, f"{self.epoch}:{last or ''}"

    def tasks(self) -> list[dict[str, Any]]:
        # Call under lock. Tagged positions also support future per-task history views.
        if self.task_cache is None:
            positions = sorted(pos for values in self.by_task.values() for pos in values)
            self.task_cache = derive_tasks(self.events[pos] for pos in positions)
        return self.task_cache


_EVENT_INDEX = EventIndex(EVENTS_PATH)


def search_messages(agent: str, q: str = "", task_id: str | None = None,
                    event_id: str | None = None, before: str | None = None,
                    direction: str = "both", limit: int = 25) -> dict[str, Any]:
    if agent != "user" and not find_agent(load_agents(), agent):
        raise ValueError("unknown agent")
    if direction not in {"both", "received", "sent"}:
        raise ValueError("direction must be both, received, or sent")
    if not 1 <= limit <= 100 or len(q) > 240:
        raise ValueError("limit must be 1–100 and q at most 240 characters")
    words = q.casefold().split()
    index = _EVENT_INDEX
    with index.lock:
        index.refresh()
        positions = index.by_participant.get(agent, [])
        end = len(positions)
        if before is not None:
            anchor = index.positions.get(before, -1)
            end = bisect_left(positions, anchor)
            if end == len(positions) or positions[end] != anchor:
                raise ValueError("unknown before event")
        start = 0
        if event_id is not None:
            pos = index.positions.get(event_id, -1)
            start = bisect_left(positions, pos, 0, end)
            end = start + int(start < end and positions[start] == pos)
        matches = []
        for i in range(end - 1, start - 1, -1):
            pos = positions[i]
            event = index.events[pos]
            if task_id is not None and event.get("task_id") != task_id:
                continue
            if direction == "sent" and event.get("from") != agent:
                continue
            if direction == "received" and agent not in recipients(event):
                continue
            if words:
                fields = [event.get(key) for key in ("id", "subject", "body", "task_id")]
                fields.extend(ref.get("value") for ref in event.get("refs") or [] if isinstance(ref, dict))
                content = "\n".join(value for value in fields if isinstance(value, str)).casefold()
                if not all(word in content for word in words):
                    continue
            matches.append(event)
            if len(matches) > limit:
                break
        return {"messages": matches[:limit], "next_before": matches[limit - 1]["id"] if len(matches) > limit else None}


def read_events() -> list[dict[str, Any]]:
    with _EVENT_INDEX.lock:
        _EVENT_INDEX.refresh()
        return _EVENT_INDEX.events[:]


def next_event_id(events: list[dict[str, Any]] | None = None) -> str:
    if events is not None:
        return f"e{max((id_num(ev.get('id')) for ev in events), default=0) + 1:03d}"
    with _EVENT_INDEX.lock:
        _EVENT_INDEX.refresh()
        return f"e{_EVENT_INDEX.max_id + 1:03d}"


def parse_ref(spec: str) -> dict[str, str]:
    if ":" not in spec:
        raise ValueError(f"ref must look like kind:value, got {spec!r}")
    kind, value = spec.split(":", 1)
    return {"kind": kind.strip(), "value": value.strip()}


def recipients(event: dict[str, Any]) -> list[str]:
    out = [event.get("to")] + list(event.get("cc") or [])
    return [r for r in out if r]


def route_error(event: dict[str, Any], data: dict[str, Any] | None = None) -> str | None:
    """None when the route is allowed, otherwise a reason."""
    data = data if data is not None else load_agents()
    src, typ = event.get("from"), event.get("type")
    if typ == "agent.status":
        return None if event.get("to") == "*" and not event.get("cc") else "agent.status goes to '*' without cc"
    sender = find_agent(data, src)
    if src != "user" and sender and agent_ended(sender):
        return ended_agent_message(sender)
    pairs = {frozenset((l["a"], l["b"])) for l in get_links(data)}
    for dst in recipients(event):
        if dst == "*":
            return "only agent.status may go to '*'"
        recipient = find_agent(data, dst)
        if dst != "user" and recipient and agent_ended(recipient):
            return ended_agent_message(recipient)
        if src == "user" or dst == "user":
            continue
        if frozenset((src, dst)) not in pairs:
            allowed = ", ".join(sorted("-".join(sorted(p)) for p in pairs))
            return f"route {src} -> {dst} not allowed; links are {allowed} (status goes to '*', human.needed to 'user')"
    return None


def append_event(event: dict[str, Any], check_route: bool = True) -> dict[str, Any]:
    for key in ("cc", "subject", "in_reply_to"):
        if not event.get(key):
            event.pop(key, None)
    if event.get("cc"):
        event["cc"] = [c for c in dict.fromkeys(event["cc"]) if c and c != event.get("to")]
    if check_route:
        err = route_error(event)
        if err:
            raise PermissionError(err)
    EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with bus_lock():
        with _EVENT_INDEX.lock:
            _EVENT_INDEX.refresh()
            if not event.get("id") or event["id"] in _EVENT_INDEX.positions:
                event["id"] = f"e{_EVENT_INDEX.max_id + 1:03d}"
        with EVENTS_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
        if event.get("from") == "user":
            pass  # USER is not an agent: no registry entry, no status
        elif event["type"] == "agent.status":
            apply_status(event["from"], event.get("state") or "working", event.get("body") or "")
        elif event["type"] == "task.blocked":
            apply_status(event["from"], "waiting", event.get("body") or "Blocked")
        elif event["type"] == "human.needed":
            apply_status(event["from"], "waiting", event.get("body") or "Needs human")
        elif event["type"] in {"task.started", "message", "task.completed", "task.failed"} and event.get("to") not in {None, "*"}:
            # sender looks active; keep its status summary (a message is not a status line)
            apply_status(event["from"], None, None)
    return event


def apply_status(agent_id: str, state: str | None, summary: str | None) -> None:
    data = load_agents()
    agent = find_agent(data, agent_id)
    if agent:
        if state is not None and not (agent.get("kind") == "temporary" and agent.get("state") in TEMP_ENDED):
            agent["state"] = state
        if summary is not None:
            agent["summary"] = summary[:160]
            agent["updated_at"] = utc_now()
        agent["last_active"] = utc_now()
    else:
        data.setdefault("agents", []).append(
            {
                "id": agent_id,
                "name": agent_id,
                "role": "unknown",
                "machine": "?",
                "tool": "unknown",
                "state": state or "working",
                "summary": (summary or "")[:160],
                "updated_at": utc_now(),
            }
        )
    save_agents(data)


def migrate_registry() -> None:
    """Add the mailroom fields (links, cli, kind) to an older agents.json without touching state."""
    with bus_lock():
        data = load_agents()
        changed = False
        if not isinstance(data.get("machines"), list):
            data["machines"] = [dict(m) for m in DEFAULT_MACHINES]
            changed = True
        if not isinstance(data.get("links"), list):
            data["links"] = [dict(x) for x in DEFAULT_LINKS]
            changed = True
        for a in data.get("agents", []):
            if "kind" not in a:
                a["kind"] = "subagent" if "." in a.get("id", "") else "permanent"
                changed = True
            if "cli" not in a and a.get("tool") in TOOL_TO_CLI:
                a["cli"] = TOOL_TO_CLI[a["tool"]]
                changed = True
        if changed:
            save_agents(data)


# ---------------------------------------------------------------- inbox cursors

def seen_path(agent_id: str) -> Path:
    return SEEN_DIR / agent_id


def get_seen(agent_id: str) -> str:
    path = seen_path(agent_id)
    return path.read_text(encoding="utf-8").strip() if path.exists() else ""


def set_seen(agent_id: str, event_id: str) -> None:
    SEEN_DIR.mkdir(parents=True, exist_ok=True)
    seen_path(agent_id).write_text(event_id + "\n", encoding="utf-8")


POLLED_DIR = BUS_DIR / ".polled"


def touch_polled(agent_id: str) -> None:
    """Remember when an agent last looked at its inbox (CLI inbox/wait or GET /api/inbox)."""
    if not re.match(r"^[A-Za-z0-9_.-]{1,40}$", agent_id or "") or agent_id == "user":
        return
    try:
        POLLED_DIR.mkdir(parents=True, exist_ok=True)
        (POLLED_DIR / agent_id).touch()
    except OSError:
        pass


def presence(index: EventIndex, data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Per-agent unread counters and last check, using the locked event index."""
    out: dict[str, dict[str, Any]] = {}
    now = time.time()
    for a in data.get("agents", []):
        aid = a["id"]
        if "." in aid:
            continue
        seen = get_seen(aid)
        positions, start = index.inbox_positions(aid, seen, missing_seen_empty=False)
        count = len(positions) - start
        marks = [p for p in (POLLED_DIR / aid, seen_path(aid)) if p.exists()]
        checked = max((p.stat().st_mtime for p in marks), default=None)
        watchers = []
        for w in BUS_DIR.glob(f".inbox-watch-{aid}-*.json"):
            try:
                st = json.loads(w.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                st = {}
            watchers.append({"thread": st.get("thread"), "last_queued_at": st.get("last_queued_at"), "file_age_min": round((now - w.stat().st_mtime) / 60, 1)})
        out[aid] = {
            "unread": count,
            "oldest_unread_ts": index.events[positions[start]].get("ts") if count else None,
            "seen_id": seen or None,
            "checked_at": iso_mtime(checked) if checked else None,
            "checked_min_ago": round((now - checked) / 60, 1) if checked else None,
            "listening": bool(checked and now - checked < LISTENING_MIN * 60),
            "watchers": watchers,
        }
    return out


def inbox_for(agent_id: str, unread_only: bool = True) -> list[dict[str, Any]]:
    last = get_seen(agent_id) if unread_only else ""
    with _EVENT_INDEX.lock:
        _EVENT_INDEX.refresh()
        positions, start = _EVENT_INDEX.inbox_positions(agent_id, last, missing_seen_empty=True)
        return [_EVENT_INDEX.events[i] for i in positions[start:]]


# ---------------------------------------------------------------- USER mailbox state

def load_user_state() -> dict[str, Any]:
    st: dict[str, Any] = {}
    if USER_STATE_PATH.exists():
        try:
            st = json.loads(USER_STATE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            st = {}
    st.setdefault("read_upto", 0)
    for key in ("read", "unread", "flagged"):
        st.setdefault(key, [])
    st.setdefault("deleted", {})
    st.setdefault("archived", {})
    return st


def init_user_state() -> None:
    """First start: everything already on the bus counts as read (the old dashboard kept read state in the browser)."""
    if USER_STATE_PATH.exists():
        return
    st = load_user_state()
    st["read_upto"] = max((id_num(e.get("id")) for e in read_events()), default=0)
    write_json(USER_STATE_PATH, st)


def update_user_state(action: str, ids: list[str]) -> dict[str, Any]:
    with bus_lock():
        st = load_user_state()
        read, unread, flagged = set(st["read"]), set(st["unread"]), set(st["flagged"])
        if action == "read":
            read |= set(ids)
            unread -= set(ids)
        elif action == "unread":
            unread |= set(ids)
            read -= set(ids)
        elif action == "read_all":
            st["read_upto"] = max((id_num(e.get("id")) for e in read_events()), default=0)
            read, unread = set(), set()
        elif action == "flag":
            flagged |= set(ids)
        elif action == "unflag":
            flagged -= set(ids)
        elif action == "delete":
            for i in ids:
                st["deleted"].setdefault(i, utc_now())
        elif action == "restore":
            for i in ids:
                st["deleted"].pop(i, None)
        elif action == "archive":
            with _EVENT_INDEX.lock:
                _EVENT_INDEX.refresh()
                now = utc_now()
                for i in ids:
                    if i in _EVENT_INDEX.positions:
                        st["archived"].setdefault(i, now)
        elif action == "unarchive":
            for i in ids:
                st["archived"].pop(i, None)
        else:
            raise ValueError(f"unknown action {action!r}")
        upto = st["read_upto"]
        st["read"] = sorted((i for i in read if id_num(i) > upto), key=id_num)
        st["unread"] = sorted(unread, key=id_num)
        st["flagged"] = sorted(flagged, key=id_num)
        write_json(USER_STATE_PATH, st)
        return st


# ---------------------------------------------------------------- machine A views

def iso_mtime(mtime: float) -> str:
    return datetime.fromtimestamp(mtime, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


_STATS_CACHE: dict[str, Any] = {"t": 0.0, "data": {}}


def local_runs() -> list[dict[str, str]]:
    """Solver containers running on this machine (machine A)."""
    try:
        res = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.RunningFor}}"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return []
    runs = []
    for line in res.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            runs.append({"name": parts[0], "status": parts[1], "machine": "A"})
    if runs:
        stats = container_stats()
        for r in runs:
            r.update(stats.get(r["name"], {}))
    return runs


def container_stats() -> dict[str, dict[str, str]]:
    now = time.time()
    if now - _STATS_CACHE["t"] < 20:
        return _STATS_CACHE["data"]
    data = {}
    try:
        res = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
                             capture_output=True, text=True, timeout=15)
        for line in res.stdout.splitlines():
            n, c, m = (line.split("\t") + ["", "", ""])[:3]
            data[n] = {"cpu": c, "mem": m}
    except Exception:
        pass
    _STATS_CACHE.update(t=now, data=data)
    return data


def machine_memory() -> dict[str, float]:
    info = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) / 1048576.0  # GiB
    except Exception:
        return {}
    return {"total_gib": round(info.get("MemTotal", 0), 1), "avail_gib": round(info.get("MemAvailable", 0), 1),
            "swap_used_gib": round(info.get("SwapTotal", 0) - info.get("SwapFree", 0), 1)}


TEXT_EXT = {".md", ".txt", ".log", ".json", ".jsonl", ".csv", ".py", ".sh", ".patch", ".diff", ".yaml", ".yml", ".toml", ".input", ".cpp", ".h", ".ts", ".tsx"}
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
        ".webp": "image/webp", ".pdf": "application/pdf"}
VIEW_MAX_BYTES = 64 * 1024 * 1024
UPLOAD_MAX_BYTES = 32 * 1024 * 1024


def save_attachment(name: str, raw: bytes) -> dict[str, Any]:
    """Store a mailroom upload in ATTACH_DIR (unique name, never overwrites)."""
    if not raw:
        raise ValueError("empty upload")
    if len(raw) > UPLOAD_MAX_BYTES:
        raise ValueError(f"file larger than {UPLOAD_MAX_BYTES // (1024 * 1024)} MiB")
    base = os.path.basename(name.replace("\\", "/")).strip()
    if not base or base.startswith("."):
        raise ValueError("need a file name")
    if any(c in base for c in '/\\') or "\x00" in base:
        raise ValueError("bad file name")
    if len(base) > 120:
        raise ValueError("file name too long")
    if base.lower().rsplit(".", 1)[-1] and f".{base.lower().rsplit('.', 1)[-1]}" not in TEXT_EXT and f".{base.lower().rsplit('.', 1)[-1]}" not in MIME:
        raise ValueError(f"extension not viewable on the bus (allowed: text/data or {', '.join(sorted(MIME))})")
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    candidate = ATTACH_DIR / base
    if candidate.exists():
        stem, ext = os.path.splitext(base)
        n = 1
        while (ATTACH_DIR / f"{stem}-{n}{ext}").exists():
            n += 1
        candidate = ATTACH_DIR / f"{stem}-{n}{ext}"
    candidate.write_bytes(raw)
    _ATTACHMENT_INDEX.invalidate()
    rel = candidate.relative_to(ATTACH_DIR)
    return {"name": rel.as_posix(), "size": len(raw), "url": f"/attach/{quote(rel.as_posix())}", "ref": f"file:coordination/{ATTACH_DIR.name}/{rel.as_posix()}"}


class AttachmentIndex:
    """Bounded metadata only, with a shared short freshness window."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        self.checked = float("-inf")
        self.records: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        self.sorted_rows: list[dict[str, Any]] = []

    def invalidate(self) -> None:
        with self.lock:
            self.checked = float("-inf")

    def list(self, *, limit: int, offset: int = 0, force: bool = False) -> list[dict[str, Any]]:
        with self.lock:
            if force or time.monotonic() - self.checked >= 15:
                self._scan()
            return self.sorted_rows[offset:offset + limit]

    def _scan(self) -> None:
        records = {}
        for directory, names, files in os.walk(self.path):
            names[:] = [name for name in names if not name.startswith(".") and name not in {"node_modules", "backups"}]
            for name in files:
                if name.startswith("."):
                    continue
                path = Path(directory) / name
                if path.suffix.lower() not in TEXT_EXT and path.suffix.lower() not in MIME:
                    continue
                if not viewable_path(path, self.path):
                    continue
                try:
                    st = path.stat()
                except OSError:
                    continue
                rel = path.relative_to(self.path).as_posix()
                sig = (st.st_mtime_ns, st.st_size)
                old = self.records.get(rel)
                record = old if old and old[0] == sig else (
                    sig, {"name": rel, "size": st.st_size, "modified": iso_mtime(st.st_mtime)},
                )
                records[rel] = record
                if len(records) >= 5000:
                    break
            if len(records) >= 5000:
                break
        self.records = records
        self.sorted_rows = [row for _, row in sorted(records.values(), key=lambda pair: pair[0][0], reverse=True)]
        self.checked = time.monotonic()


_ATTACHMENT_INDEX = AttachmentIndex(ATTACH_DIR)


def attachments_list(limit: int = 300, offset: int = 0, force: bool = False) -> list[dict[str, Any]]:
    return _ATTACHMENT_INDEX.list(limit=limit, offset=offset, force=force)


def list_repo_dir(rel: str) -> dict[str, Any]:
    """List immediate non-hidden directory entries strictly inside REPO_DIR (excluding STORE_DIR)."""
    clean = (rel or "").strip().replace("\\", "/")
    parts = [p for p in clean.split("/") if p and p != "."]
    if ".." in parts or any(p.startswith(".") for p in parts):
        raise FileNotFoundError("no such directory")
    base = REPO_DIR.resolve()
    store_base = STORE_DIR.resolve()
    try:
        target = base.joinpath(*parts).resolve() if parts else base
    except (ValueError, OSError) as exc:
        raise FileNotFoundError("no such directory") from exc
    if target != base and not viewable_path(target, base):
        raise FileNotFoundError("no such directory")
    if target == store_base or target.is_relative_to(store_base):
        raise FileNotFoundError("no such directory")
    if not target.is_dir():
        raise FileNotFoundError("no such directory")

    entries: list[dict[str, Any]] = []
    for child in target.iterdir():
        name = child.name
        if name.startswith(".") or name in {"__pycache__", "node_modules"}:
            continue
        try:
            resolved_child = child.resolve()
            if resolved_child == store_base or resolved_child.is_relative_to(store_base):
                continue
            if not viewable_path(resolved_child, base):
                continue
            st = resolved_child.stat()
            is_dir = resolved_child.is_dir()
            is_file = resolved_child.is_file()
        except OSError:
            continue
        if not (is_dir or is_file):
            continue
        rel_child = child.relative_to(base).as_posix()
        ext = resolved_child.suffix.lower()
        viewable = bool(is_file and (ext in TEXT_EXT or ext in MIME) and st.st_size <= VIEW_MAX_BYTES)
        entries.append({
            "name": name,
            "path": rel_child,
            "kind": "dir" if is_dir else "file",
            "size": 0 if is_dir else st.st_size,
            "modified": iso_mtime(st.st_mtime),
            "viewable": viewable,
        })
    entries.sort(key=lambda row: (0 if row["kind"] == "dir" else 1, row["name"].lower(), row["name"]))
    rel_dir = target.relative_to(base).as_posix() if target != base else ""
    parent_dir = target.parent.relative_to(base).as_posix() if target != base else None
    if parent_dir == ".":
        parent_dir = ""
    return {"path": rel_dir, "abs_path": str(target), "parent": parent_dir, "entries": entries}


# ---------------------------------------------------------------- tasks

def derive_tasks(events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    tasks: dict[str, dict[str, Any]] = {}
    for ev in events:
        tid = ev.get("task_id")
        if not tid:
            continue
        slot = tasks.setdefault(
            tid,
            {
                "task_id": tid,
                "parent_task_id": ev.get("parent_task_id"),
                "owner": ev.get("to") if ev["type"].startswith("task.") else ev.get("from"),
                "state": "open",
                "title": ev.get("subject") or ev.get("body") or tid,
                "updated_at": ev.get("ts"),
            },
        )
        if ev.get("parent_task_id"):
            slot["parent_task_id"] = ev["parent_task_id"]
        slot["updated_at"] = ev.get("ts")
        if ev["type"] == "task.started":
            slot["state"] = "started"
            slot["owner"] = ev.get("to")
            slot["title"] = ev.get("body") or slot["title"]
        elif ev["type"] == "task.blocked":
            slot["state"] = "blocked"
        elif ev["type"] == "task.completed":
            slot["state"] = "completed"
        elif ev["type"] == "task.failed":
            slot["state"] = "failed"
        elif ev["type"] == "human.needed":
            slot["state"] = "waiting_human"
    return sorted(tasks.values(), key=lambda t: t.get("updated_at") or "", reverse=True)


# ---------------------------------------------------------------- machines

def get_machines(data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    data = data if data is not None else load_agents()
    ms = data.get("machines")
    return ms if isinstance(ms, list) else [dict(m) for m in DEFAULT_MACHINES]


def find_machine(machine_id: str, data: dict[str, Any] | None = None) -> dict[str, Any] | None:
    return next((m for m in get_machines(data) if m.get("id") == machine_id), None)


def ssh_endpoint(machine: dict[str, Any]) -> tuple[list[str], str] | None:
    """(ssh options, target) taken from the machine's tunnel unit ExecStart."""
    unit = machine.get("tunnel_unit")
    if not unit:
        return None
    try:
        res = systemctl("cat", unit)
    except Exception:
        return None
    line = next((l for l in res.stdout.splitlines() if l.startswith("ExecStart=")), "")
    parts = line[len("ExecStart="):].replace("%h", str(Path.home())).split()
    if not parts:
        return None
    opts, i = [], 1
    while i < len(parts) - 1:
        if parts[i] == "-i":
            opts += ["-i", parts[i + 1]]
            i += 2
        else:
            i += 1
    return opts + ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"], parts[-1]


def tunnel_remote_port(machine: dict[str, Any]) -> int:
    """Port the reverse tunnel opens on the remote machine (from `-R [bind:]port:host:hostport`)."""
    try:
        line = next((l for l in systemctl("cat", machine.get("tunnel_unit", "")).stdout.splitlines() if l.startswith("ExecStart=")), "")
    except Exception:
        return PUBLIC_PORT
    m = re.search(r"-R\s+(?:[^\s:]+:)?(\d+):", line)
    return int(m.group(1)) if m else PUBLIC_PORT


def ssh_run(machine: dict[str, Any], script: str, timeout: int = 20) -> subprocess.CompletedProcess:
    ep = ssh_endpoint(machine)
    if not ep:
        raise RuntimeError(f"no SSH endpoint for machine {machine.get('id')} (tunnel unit missing)")
    opts, target = ep
    return subprocess.run(["ssh", *opts, target, script], capture_output=True, text=True, timeout=timeout)


def probe_machine(machine: dict[str, Any]) -> dict[str, Any]:
    st: dict[str, Any] = {"checked_at": utc_now()}
    unit = machine.get("tunnel_unit")
    if unit:
        try:
            st["tunnel_active"] = systemctl("is-active", unit).stdout.strip() == "active"
        except Exception:
            st["tunnel_active"] = False
    clis = " ".join(sorted({p["bin"] for p in CLI_PRESETS.values()}))
    port = tunnel_remote_port(machine)
    st["bus_port"] = port
    script = (
        f'export PATH="{REMOTE_PATH}"; echo os=$(uname -r); '
        "awk '/MemTotal/{print \"mem_total_kb=\"$2} /MemAvailable/{print \"mem_avail_kb=\"$2}' /proc/meminfo; "
        f'for c in {clis}; do command -v $c >/dev/null && echo cli=$c; done; '
        f'echo bus=$(curl -s -m 4 -o /dev/null -w "%{{http_code}}" http://127.0.0.1:{port}/api/agents); '
        f'test -d "$HOME/{machine.get("repo", "")}" && echo repo=yes'
    )
    t0 = time.time()
    try:
        res = ssh_run(machine, script)
    except Exception as exc:
        st.update(reachable=False, error=str(exc)[:200])
        return st
    st["latency_ms"] = round((time.time() - t0) * 1000)
    if res.returncode != 0 and "os=" not in res.stdout:
        st.update(reachable=False, error=(res.stderr.strip() or f"ssh exit {res.returncode}")[:200])
        return st
    st["reachable"] = True
    st["clis"] = []
    for line in res.stdout.splitlines():
        k, _, v = line.partition("=")
        if k == "cli":
            st["clis"].append(v)
        elif k in {"mem_total_kb", "mem_avail_kb"} and v.isdigit():
            st[k.replace("_kb", "_gib")] = round(int(v) / 1048576, 1)
        elif k == "os":
            st["os"] = v
            st["wsl"] = "microsoft" in v.lower()
        elif k == "bus":
            st["bus_via_tunnel"] = v == "200"
        elif k == "repo":
            st["repo_found"] = True
    return st


def machine_status(data: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    out = []
    for m in get_machines(data):
        row = {k: v for k, v in m.items()}
        if m.get("kind") == "local":
            mem = machine_memory()
            row.update(reachable=True, mem_total_gib=mem.get("total_gib"), mem_avail_gib=mem.get("avail_gib"),
                       clis=[k for k, v in CLI_PRESETS.items() if shutil.which(v["bin"], path=agent_path())], checked_at=utc_now())
        else:
            row.update(_MACHINE_STATUS.get(m["id"], {"checked_at": None}))
            row["clis"] = [k for k, v in CLI_PRESETS.items() if v["bin"] in (row.get("clis") or [])] if row.get("clis") is not None else []
        out.append(row)
    return out


def probe_loop() -> None:
    while True:
        for m in get_machines():
            if m.get("kind") == "ssh":
                try:
                    _MACHINE_STATUS[m["id"]] = probe_machine(m)
                except Exception as exc:
                    _MACHINE_STATUS[m["id"]] = {"checked_at": utc_now(), "reachable": False, "error": str(exc)[:200]}
        time.sleep(PROBE_EVERY_S)


# ---------------------------------------------------------------- temporary agents

def systemctl(*args: str, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=timeout)


def unit_info(unit: str) -> dict[str, Any]:
    try:
        res = systemctl("show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent", "-p", "MemoryPeak",
                        "-p", "ExecMainStatus", "-p", "Result")
    except Exception:
        return {}
    out: dict[str, Any] = {}
    for line in res.stdout.splitlines():
        k, _, v = line.partition("=")
        out[k] = v
    for k in ("MemoryCurrent", "MemoryPeak"):
        try:
            out[k] = int(out.get(k, ""))
        except ValueError:
            out[k] = None
    return out


def next_temp_id(data: dict[str, Any]) -> str:
    n = 0
    for a in data.get("agents", []):
        m = re.match(r"t(\d+)$", a.get("id", ""))
        if m:
            n = max(n, int(m.group(1)))
    return f"t{n + 1}"


def role_text(agent: dict[str, Any]) -> str:
    if (agent.get("role_prompt") or "").strip():
        return agent["role_prompt"].strip()
    preset = ROLE_PRESETS.get(agent.get("role_preset") or "")
    return preset["prompt"] if preset else ""


def agent_peers(agent_id: str, data: dict[str, Any] | None = None) -> list[str]:
    return sorted({l["b"] if l["a"] == agent_id else l["a"] for l in get_links(data) if agent_id in (l["a"], l["b"])})


def agent_instructions(agent: dict[str, Any], brief_id: str | None = None, data: dict[str, Any] | None = None) -> str:
    """Standing instructions: who you are, your role, how to use the bus, and how to keep watching your inbox."""
    aid = agent["id"]
    temporary = agent.get("kind") == "temporary"
    peers = ", ".join(["user"] + (agent.get("peers") or agent_peers(aid, data)))
    machine = find_machine(agent.get("machine") or "A", data)
    remote = bool(machine and machine.get("kind") == "ssh")
    bus = f"python3 {BUS_PY}"
    # Only spell out the data location when a plain `python3 bus.py` would not find it on its own.
    env = (f"BUS_DATA_DIR={BUS_DIR} " if os.environ.get("BUS_DATA_DIR")
           else f"COORD_STORE={STORE_DIR} " if STORE_SOURCE == "env" else "")
    if env and not temporary:  # temporary units already get BUS_DATA_DIR in their environment
        bus = env + bus
    setup = ""
    if remote:
        rport = tunnel_remote_port(machine)
        bus = "python3 ~/bus_client.py" if rport == 8766 else f"BUS_URL=http://127.0.0.1:{rport} python3 ~/bus_client.py"
        setup = (
            f"You are on {machine.get('label', 'a remote machine')}. The bus is reachable at http://127.0.0.1:{rport} through the configured reverse SSH tunnel. "
            f"Get the bus client once (it has the same commands as bus.py):\n  curl -s http://127.0.0.1:{rport}/bus_client.py -o ~/bus_client.py\n"
            "If the tunnel is down, keep working and post when it returns.\n\n"
        )
        repo_hint = f"~/{machine.get('repo', '')}".rstrip("/")
    else:
        repo_hint = str(REPO_DIR)
    who = (
        f'You are {aid} ("{agent.get("name", aid)}"), a TEMPORARY agent summoned by USER on the agent message bus of the repository at {REPO_DIR if not remote else "~/" + machine.get("repo", "")}. '
        f"Your time ends at {agent['expires_at']} (UTC); your process is stopped then."
        if temporary
        else f'You are {aid} ("{agent.get("name", aid)}") on the agent message bus of the repository at {REPO_DIR}. USER follows and answers on the Mission control mailroom.'
    )
    role = role_text(agent)
    first = (
        f"Your brief is bus message {brief_id} in your inbox. Read it first:\n  {bus} inbox --agent {aid}"
        if brief_id
        else f"Start by reading your unread messages:\n  {bus} inbox --agent {aid}"
    )
    limits = (
        "Unless the brief explicitly says otherwise: do not start unrelated compute jobs or containers, do not commit or push, do not delete or overwrite other people's files."
        if temporary
        else "Follow the workspace rules and stay within the assigned scope."
    )
    if temporary:
        idle = (
            f"While the timed session is running, block in the shell with {bus} wait --agent {aid} --timeout 90. "
            "When it wakes, handle new mail and return to the shell wait. Stop when USER says you are done or shortly before expiry; post a one-line final summary first."
        )
    else:
        idle = (
            "When idle, rely on the external watcher configured for this CLI, if present. "
            f"Otherwise, this CLI can wait without model polling by blocking in the shell: {bus} wait --agent {aid} --timeout 90. "
            "If this session cannot keep a shell task open, return control and read the inbox next time you are resumed."
        )
    if not temporary:
        idle = "During long work, check your inbox between steps (at least every 15 minutes) and post status when your work changes. " + idle
    return f"""{who}
{f"{chr(10)}Your role: {role}{chr(10)}" if role else ""}
{setup}{first}

Rules:
- Read {repo_hint}/AGENTS.md if present and follow its workspace rules. {limits}
- You may message only: {peers}. Reply in the thread of the message you answer:
  {bus} post --from {aid} --to <recipient> --in-reply-to <event id> --task-id <its task id, if any> --body "..."
  Add --cc <agent> to copy a teammate you may message. Keep the body short (numbers, verdict). {"Longer text: put it in a file in the shared workspace and cite it with --ref path:<workspace-relative path>." if remote else f"Longer text goes into {ATTACH_DIR}/<YYYY-MM-DD_HHMM>_{aid}_<topic>.md, attached with --ref file:coordination/attachments/<name>."}
  Lifecycle types: --type task.started | task.completed | task.failed | task.blocked; --type human.needed --to user for a decision only USER can make.
- Use {bus} inbox --agent {aid} for unread work.
- Find your past messages without changing unread state:
  {bus} search --agent {aid} --q "<keywords>" --task-id <id>
  The keyword and task filters are optional. Use --event-id to look up a known message.
- Check who is on the team, their roles, live state/activity estimates, and configured registry routes with {bus} team (available/reachable reflect the last {LISTENING_MIN} min of inbox or status activity; a persistent watcher refreshes listening while idle/waiting and does not establish spare capacity).
- Read project task state with `{bus} todo list` and `{bus} todo show <task id>`. Use `todo update <task id> --agent {aid} --revision <current revision>` with --state or --next-action for explicit task edits.
- Report progress to the team with {bus} status --agent {aid} --state working --summary "Short progress update". For a USER decision, post --type human.needed --to user with the task ID, question and available options.
- After handling messages: {bus} mark-seen --agent {aid} --event-id <last handled event id>
- {idle}
"""


def build_prompt(agent: dict[str, Any], brief_id: str) -> str:
    return agent_instructions(agent, brief_id)


def summon(req: dict[str, Any]) -> dict[str, Any]:
    cli = req.get("cli")
    if cli not in CLI_PRESETS:
        raise ValueError(f"cli must be one of {sorted(CLI_PRESETS)}")
    preset = CLI_PRESETS[cli]
    model = (req.get("model") or "").strip()
    if cli == "opencode" and model and not re.fullmatch(r"[^/\s]+/\S+", model):
        raise ValueError("OpenCode models need provider/model, for example opencode/glm-5.3-flash-free")
    ttl_min = int(req.get("ttl_min") or 30)
    if not 1 <= ttl_min <= MAX_TTL_MIN:
        raise ValueError(f"duration must be 1-{MAX_TTL_MIN} minutes")
    brief = (req.get("brief") or "").strip()
    if not brief:
        raise ValueError("the brief (first message) is empty")
    access = "full" if req.get("access") == "full" else "standard"
    machine_id = req.get("machine") or "A"
    machine = find_machine(machine_id)
    if not machine:
        raise ValueError(f"unknown machine {machine_id!r}")
    remote = machine.get("kind") == "ssh"

    if remote:
        st = _MACHINE_STATUS.get(machine_id) or probe_machine(machine)
        if not st.get("reachable"):
            raise RuntimeError(f"{machine.get('label')} is not reachable over SSH: {st.get('error', 'no probe yet')}")
        if not st.get("bus_via_tunnel"):
            raise RuntimeError(f"the bus is not reachable from {machine.get('label')} (reverse tunnel down?)")
        if preset["bin"] not in (st.get("clis") or []):
            raise RuntimeError(f"{preset['bin']} is not installed on {machine.get('label')} (checked {st.get('checked_at')})")
        avail = st.get("mem_avail_gib")
        binary = preset["bin"]
    else:
        avail = machine_memory().get("avail_gib")
        binary = shutil.which(preset["bin"], path=agent_path())
        if not binary:
            raise RuntimeError(f"{preset['bin']} not found on PATH")
    if avail is not None and avail - SUMMON_EST_GIB < MIN_AVAIL_AFTER_GIB:
        raise RuntimeError(f"only {avail} GiB available on {machine.get('label')}; a temporary agent (~{SUMMON_EST_GIB} GiB est.) would leave < {MIN_AVAIL_AFTER_GIB} GiB")

    now = datetime.now(timezone.utc).replace(microsecond=0)
    with bus_lock():
        data = load_agents()
        active = [a for a in data.get("agents", []) if a.get("kind") == "temporary" and not agent_ended(a)]
        if len(active) >= MAX_ACTIVE_TEMP:
            raise RuntimeError(f"{len(active)} temporary agents already active (limit {MAX_ACTIVE_TEMP}); stop one first")
        known = {a["id"] for a in data.get("agents", [])}
        peers = [p for p in (req.get("peers") or []) if p in known and p != "user"]
        agent_id = next_temp_id(data)
        agent = {
            "id": agent_id,
            "name": (req.get("name") or f"{preset['label']} (temp)").strip()[:60],
            "role": (ROLE_PRESETS.get(req.get("role_preset") or "", {}).get("label") or req.get("role") or "temporary").strip()[:40],
            "role_preset": req.get("role_preset") if req.get("role_preset") in ROLE_PRESETS else None,
            "role_prompt": (req.get("role_prompt") or "").strip()[:4000] or None,
            "machine": machine_id,
            "tool": cli,
            "cli": cli,
            "kind": "temporary",
            "state": "starting",
            "summary": f"Summoned by USER for {ttl_min} min",
            "summoned_at": now.isoformat().replace("+00:00", "Z"),
            "expires_at": (now + timedelta(minutes=ttl_min)).isoformat().replace("+00:00", "Z"),
            "ttl_min": ttl_min,
            "access": access,
            "model": model or None,
            "peers": peers,
            "unit": f"mailroom-{agent_id}-{secrets.token_hex(3)}",
            "updated_at": utc_now(),
            "last_active": utc_now(),
        }
        data["agents"].append(agent)
        links = get_links(data)
        for p in peers:
            links.append({"a": agent_id, "b": p, "note": f"temporary agent {agent_id}"})
        data["links"] = links
        save_agents(data)

    brief_ev = append_event({
        "id": None, "ts": utc_now(), "type": "message", "from": "user", "to": agent_id,
        "cc": [c for c in (req.get("cc") or []) if c in known],
        "task_id": (req.get("task_id") or "").strip() or None, "parent_task_id": None,
        "subject": (req.get("subject") or "").strip() or None, "body": brief, "refs": [],
    })
    prompt = build_prompt(agent, brief_ev["id"])
    repo = f"$HOME/{machine.get('repo', '')}".rstrip("/") if remote else str(REPO_DIR)
    fill = {"prompt": prompt, "repo": repo, "model": agent["model"] or "", "ttl_s": str(ttl_min * 60), "bus_py": str(BUS_PY)}
    argv = [part.format(**fill) for part in preset[access]]
    if agent["model"]:
        argv += [part.format(**fill) for part in preset["model"]]
    argv[0] = binary
    if remote:
        # Remote: the A-side unit holds an ssh session (killed at RuntimeMaxSec or on Stop); -tt makes the remote
        # side hang up with it, and the remote `timeout` is a backstop if the link drops.
        import shlex
        quoted = " ".join(a if a.startswith("$HOME/") else shlex.quote(a) for a in argv)
        remote_cmd = f'export PATH="{REMOTE_PATH}"; cd "{repo}" && exec timeout -k 30 {ttl_min * 60}s {quoted}'
        opts, target = ssh_endpoint(machine)
        argv = ["ssh", "-tt", *opts, "-o", "ServerAliveInterval=30", target, remote_cmd]

    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    log = SESSIONS_DIR / f"{agent_id}.log"
    (SESSIONS_DIR / f"{agent_id}.prompt.txt").write_text(prompt, encoding="utf-8")
    cmd = [
        "systemd-run", "--user", f"--unit={agent['unit']}",
        f"--description=Mailroom temporary agent {agent_id} ({cli})",
        f"--working-directory={REPO_DIR}",
        f"--property=RuntimeMaxSec={ttl_min * 60}",
        f"--property=MemoryMax={SUMMON_MEMORY_MAX_GIB}G",
        f"--property=StandardOutput=append:{log}",
        f"--property=StandardError=append:{log}",
        f"--setenv=PATH={agent_path()}",
        f"--setenv=HOME={Path.home()}",
        f"--setenv=BUS_DATA_DIR={BUS_DIR}",
        f"--setenv=COORD_STORE={COORD_DIR}",
        f"--setenv=BUS_AGENT_ID={agent_id}",
        "--", *argv,
    ]
    shown = [("<prompt: sessions/%s.prompt.txt>" % agent_id) if a == prompt else (a.replace(prompt, "<prompt>") if prompt in a else a) for a in cmd]
    if remote:
        shown = [x if not x.startswith(ssh_endpoint(machine)[1]) else "<ssh target from tunnel unit>" for x in shown]
    log.write_text(f"[{utc_now()}] {' '.join(shown)}\n", encoding="utf-8")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        try:
            systemctl("stop", agent["unit"])
        except (OSError, subprocess.SubprocessError):
            pass
        end_temp_agent(agent_id, "failed", "Could not start the temporary agent. See its process log.")
        raise RuntimeError(f"Could not start the temporary agent: {exc}") from exc
    if res.returncode != 0:
        end_temp_agent(agent_id, "failed", f"Launch failed: {res.stderr.strip()}")
        raise RuntimeError(f"systemd-run failed: {res.stderr.strip()}")
    with bus_lock():
        data = load_agents()
        a = find_agent(data, agent_id)
        if a["state"] == "starting":
            a["state"] = "working"
            a["summary"] = f"Working on {brief_ev['id']} (summoned for {ttl_min} min)"
            a["updated_at"] = utc_now()
            save_agents(data)
    return {"agent": a, "brief": brief_ev, "command": shown}


def agent_path() -> str:
    extra = [str(Path.home() / ".local/bin"), "/snap/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    parts = (os.environ.get("PATH") or "").split(":") + extra
    return ":".join(dict.fromkeys(p for p in parts if p))


def end_temp_agent(agent_id: str, state: str, note: str) -> None:
    """Mark a temporary agent ended, drop its links and post a status line (bypasses the route check on purpose)."""
    with bus_lock():
        data = load_agents()
        a = find_agent(data, agent_id)
        if not a or a.get("kind") != "temporary" or a.get("state") in TEMP_ENDED:
            return
        a["state"] = state
        a["summary"] = note[:160]
        a["ended_at"] = utc_now()
        a["updated_at"] = utc_now()
        data["links"] = [l for l in get_links(data) if agent_id not in (l["a"], l["b"])]
        save_agents(data)
    append_event({"id": None, "ts": utc_now(), "type": "agent.status", "from": agent_id, "to": "*", "task_id": None,
                  "parent_task_id": None, "body": note, "state": "offline", "refs": []}, check_route=False)


def stop_temp_agent(agent_id: str) -> None:
    a = find_agent(load_agents(), agent_id)
    if not a or a.get("kind") != "temporary":
        raise ValueError(f"{agent_id} is not a temporary agent")
    if a.get("state") in TEMP_ENDED:
        return
    if a.get("unit"):
        systemctl("stop", a["unit"], timeout=60)
    end_temp_agent(agent_id, "stopped", f"Stopped by USER at {utc_now()}")


def reap_temp_agents() -> None:
    """Record memory peaks of running temporary agents and mark ended ones."""
    data = load_agents()
    for a in data.get("agents", []):
        if a.get("kind") != "temporary" or a.get("state") in TEMP_ENDED or not a.get("unit"):
            continue
        info = unit_info(a["unit"])
        active = info.get("ActiveState") in {"active", "activating", "deactivating", "reloading"}
        peak = info.get("MemoryPeak") or info.get("MemoryCurrent")
        if peak and peak > (a.get("mem_peak_bytes") or 0):
            with bus_lock():
                d2 = load_agents()
                a2 = find_agent(d2, a["id"])
                if a2:
                    a2["mem_peak_bytes"] = peak
                    save_agents(d2)
        if active:
            continue
        exp = parse_ts(a.get("expires_at"))
        result = info.get("Result")
        timed_out = result == "timeout" or (info.get("LoadState") == "not-found" and exp and exp <= datetime.now(timezone.utc))
        if timed_out:
            end_temp_agent(a["id"], "expired", f"Time ended at {a.get('expires_at')}; process stopped.")
        elif info.get("ActiveState") == "failed":
            status = info.get("ExecMainStatus", "unknown")
            end_temp_agent(a["id"], "failed", f"Process failed ({result or 'unknown'}, status {status}). See its process log.")
        elif a.get("state") != "starting":
            end_temp_agent(a["id"], "finished", f"Process exited at {utc_now()} before its time ended.")
        if info.get("ActiveState") == "failed":
            # Failed units stay loaded until we have saved their exit status.
            systemctl("reset-failed", a["unit"])


def session_log(agent_id: str, max_bytes: int = 40000) -> str:
    log = SESSIONS_DIR / f"{Path(agent_id).name}.log"
    try:
        with log.open("rb") as stream:
            end = stream.seek(0, os.SEEK_END)
            stream.seek(max(0, end - max_bytes))
            return stream.read(max_bytes).decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def update_session_id(agent_id: str, session_id: str, previous_id: str) -> dict[str, Any]:
    check_session_id(session_id)
    with bus_lock():
        data = load_agents()
        agent = find_agent(data, agent_id)
        if not agent:
            raise ValueError("Unknown agent")
        if (agent.get("session_id") or "") != previous_id:
            raise ValueError("The saved session ID changed. Refresh and try again.")
        agent["session_id"] = session_id
        save_agents(data)
        return agent


def check_session_id(session_id: str) -> None:
    if not isinstance(session_id, str) or (session_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,159}", session_id)):
        raise ValueError("Use the session or conversation ID from the agent’s CLI")


# ---------------------------------------------------------------- registry edits from the Team page

AGENT_FIELDS = ("name", "role", "role_preset", "role_prompt", "machine", "cli", "session_id", "workdir", "notes", "retired")


def upsert_agent(req: dict[str, Any]) -> dict[str, Any]:
    agent_id = (req.get("id") or "").strip()
    if not re.match(r"^[a-z][a-z0-9_.-]{0,31}$", agent_id) or agent_id in {"user", "*"}:
        raise ValueError("agent id must be lowercase letters/digits (e.g. a6), not 'user'")
    if "session_id" in req:
        check_session_id(req["session_id"])
    with bus_lock():
        data = load_agents()
        a = find_agent(data, agent_id)
        if a is None:
            a = {"id": agent_id, "kind": "permanent", "state": "idle", "summary": "Registered by USER",
                 "tool": req.get("cli") or "unknown", "updated_at": utc_now()}
            data.setdefault("agents", []).append(a)
        elif a.get("kind") == "temporary":
            raise ValueError("temporary agents are managed by summon/stop")
        for k in AGENT_FIELDS:
            if k in req:
                a[k] = req[k]
        if a.get("retired"):
            a["state"] = "offline"
        save_agents(data)
        return a


def set_links(links: list[dict[str, Any]]) -> list[dict[str, str]]:
    clean, seen = [], set()
    for l in links:
        a, b = str(l.get("a") or ""), str(l.get("b") or "")
        if not a or not b or a == b or "user" in (a, b) or "*" in (a, b):
            continue
        key = frozenset((a, b))
        if key in seen:
            continue
        seen.add(key)
        clean.append({"a": a, "b": b, "note": str(l.get("note") or "")[:200]})
    with bus_lock():
        data = load_agents()
        data["links"] = clean
        save_agents(data)
    return clean


# ---------------------------------------------------------------- CLI

def cmd_post(args: argparse.Namespace) -> int:
    if args.type not in VALID_TYPES:
        print(f"invalid type {args.type!r}; choose from {sorted(VALID_TYPES)}", file=sys.stderr)
        return 2
    if args.from_agent == "user":
        print("posting as 'user' is reserved for USER's dashboard box", file=sys.stderr)
        return 3
    refs = [parse_ref(r) for r in (args.ref or [])]
    event = {
        "id": args.id,
        "ts": args.ts or utc_now(),
        "type": args.type,
        "from": args.from_agent,
        "to": args.to,
        "cc": args.cc,
        "task_id": args.task_id,
        "parent_task_id": args.parent_task_id,
        "subject": args.subject,
        "in_reply_to": args.in_reply_to,
        "body": args.body,
        "refs": refs,
    }
    if args.type == "agent.status":
        event["state"] = args.state or "working"
    try:
        append_event(event)
    except PermissionError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    print(json.dumps(event, indent=2))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    event = {
        "id": None,
        "ts": utc_now(),
        "type": "agent.status",
        "from": args.agent,
        "to": "*",
        "task_id": args.task_id,
        "parent_task_id": None,
        "body": args.summary,
        "state": args.state,
        "refs": [],
    }
    append_event(event)
    print(json.dumps(event, indent=2))
    return 0


def cmd_inbox(args: argparse.Namespace) -> int:
    touch_polled(args.agent)
    print(json.dumps(inbox_for(args.agent, unread_only=not args.all), indent=2))
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    try:
        result = search_messages(args.agent, args.q, args.task_id, args.event_id, args.before, args.direction, args.limit)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


def cmd_wait(args: argparse.Namespace) -> int:
    """Block until the agent has unread messages (prints them) or the timeout passes (prints [])."""
    deadline = time.time() + max(1, args.timeout)
    last_mtime = -1.0
    while True:
        touch_polled(args.agent)
        mtime = EVENTS_PATH.stat().st_mtime if EVENTS_PATH.exists() else 0.0
        if mtime != last_mtime:
            last_mtime = mtime
            items = inbox_for(args.agent)
            if items:
                print(json.dumps(items, indent=2))
                return 0
        if agent_ended(find_agent(load_agents(), args.agent)):
            print(json.dumps({"ended": True, "note": "your time has ended; post nothing more and exit"}))
            return 0
        if time.time() >= deadline:
            print("[]")
            return 0
        time.sleep(2)


def cmd_mark_seen(args: argparse.Namespace) -> int:
    if args.event_id:
        set_seen(args.agent, args.event_id)
    else:
        with _EVENT_INDEX.lock:
            _EVENT_INDEX.refresh()
            latest = _EVENT_INDEX.events[-1]["id"] if _EVENT_INDEX.events else ""
        set_seen(args.agent, latest)
    print(get_seen(args.agent))
    return 0


def cmd_dump(args: argparse.Namespace) -> int:
    events = read_events()
    payload = {"agents": load_agents()["agents"], "links": get_links(), "events": events, "tasks": derive_tasks(events)}
    print(json.dumps(payload, indent=2))
    return 0


def cmd_todo(args: argparse.Namespace) -> int:
    from bus_client import todo_payload
    from todo_store import TodoError

    try:
        if args.action == "seed":
            result = todo_store().seed(0 if args.dry_run else todo_last_event(), dry_run=args.dry_run)
        elif args.action in {"list", "show"}:
            result = todo_read({"id": getattr(args, "id", None)}, admin=False)
        else:
            result = todo_mutation(todo_payload(args), admin=True)
    except (TodoError, OSError) as exc:
        print(json.dumps({"error": str(exc), "current": getattr(exc, "current", None)}), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return int(bool(result.get("export_warning")))


def cmd_register(args: argparse.Namespace) -> int:
    req = {k: v for k, v in vars(args).items() if k in AGENT_FIELDS + ("id",) and v is not None}
    try:
        print(json.dumps(upsert_agent(req), indent=2))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


def cmd_instructions(args: argparse.Namespace) -> int:
    data = load_agents()
    a = find_agent(data, args.agent)
    if not a:
        print(f"no agent {args.agent!r}", file=sys.stderr)
        return 2
    print(agent_instructions(a, data=data))
    return 0


def member_availability(agent: dict[str, Any], pres: dict[str, Any], now: datetime) -> str:
    """Derive live availability from registry flags, agent state, and recent inbox/status activity."""
    if agent.get("retired"):
        return "retired"
    if agent_ended(agent):
        return "ended"
    state = agent.get("state") or "idle"
    if state in ("offline", "failed"):
        return state
    listening = bool(pres.get("listening"))
    recent_ts = parse_ts(agent.get("last_active")) or parse_ts(agent.get("updated_at"))
    active_recently = bool(recent_ts and (now - recent_ts).total_seconds() < LISTENING_MIN * 60)
    if listening or active_recently:
        return "busy" if state == "working" else "available"
    return "away"


def team_roster(*, include_all: bool = False, available_only: bool = False) -> dict[str, Any]:
    """List team members with role, machine, live state/activity estimates, and registry routes.

    `available` and `reachable` are 15-minute (`LISTENING_MIN`) activity estimates derived from
    recent inbox/status timestamps; a persistent watcher can refresh `listening` while an agent
    is idle or waiting, so neither establishes spare capacity. `links` and `peers` describe
    configured registry routes while live `state` is reported separately.
    """
    data = load_agents()
    links = get_links(data)
    machines = {m["id"]: m.get("label") or m["id"] for m in get_machines(data)}
    with _EVENT_INDEX.lock:
        _EVENT_INDEX.refresh()
        live_presence = presence(_EVENT_INDEX, data)
    now = datetime.now(timezone.utc)
    members = []
    for a in data.get("agents", []):
        aid = a.get("id") or ""
        if not aid or ("." in aid and not include_all):
            continue
        retired = bool(a.get("retired"))
        ended = agent_ended(a)
        if not include_all and (retired or ended):
            continue
        kind = a.get("kind") or ("subagent" if "." in aid else "permanent")
        pres = live_presence.get(aid) or {}
        availability = member_availability(a, pres, now)
        available = availability == "available"
        reachable = availability in ("available", "busy")
        if available_only and not available:
            continue
        peers = [p for p in agent_peers(aid, data) if not agent_ended(find_agent(data, p))]
        role = (a.get("role") or "").strip() or (ROLE_PRESETS.get(a.get("role_preset") or "", {}).get("label") or "")
        machine_id = a.get("machine") or "A"
        members.append(
            {
                "id": aid,
                "name": a.get("name") or aid,
                "role": role,
                "role_preset": a.get("role_preset"),
                "kind": kind,
                "machine": machine_id,
                "machine_label": machines.get(machine_id, machine_id),
                "state": a.get("state") or "idle",
                "availability": availability,
                "available": available,
                "reachable": reachable,
                "listening": bool(pres.get("listening")),
                "summary": a.get("summary") or "",
                "unread": pres.get("unread", 0),
                "checked_at": pres.get("checked_at"),
                "checked_min_ago": pres.get("checked_min_ago"),
                "updated_at": a.get("updated_at"),
                "last_active": a.get("last_active"),
                "retired": retired,
                "ended": ended,
                "peers": peers,
            }
        )
    return {
        "members": members,
        "links": links,
        "listening_window_min": LISTENING_MIN,
        "generated_at": utc_now(),
    }


def cmd_links(args: argparse.Namespace) -> int:
    print(json.dumps(get_links(), indent=2))
    return 0


def cmd_team(args: argparse.Namespace) -> int:
    print(json.dumps(team_roster(include_all=args.all, available_only=args.available), indent=2))
    return 0


# Keep expensive process enumeration shared across tabs in one polling round.
_TELEMETRY_LOCK = threading.Lock()
_TELEMETRY_CHECKED = float("-inf")
_TELEMETRY: dict[str, Any] = {}


def snapshot_telemetry() -> dict[str, Any]:
    global _TELEMETRY_CHECKED, _TELEMETRY
    with _TELEMETRY_LOCK:
        if time.monotonic() - _TELEMETRY_CHECKED >= 4:
            _TELEMETRY = {"runs": local_runs(), "processes": []}
            _TELEMETRY_CHECKED = time.monotonic()
        return _TELEMETRY


def supports_gzip(header: str) -> bool:
    for item in header.lower().split(","):
        coding, *params = item.split(";")
        if coding.strip() != "gzip":
            continue
        try:
            return all(float(key.partition("=")[2]) > 0
                       for key in params if key.partition("=")[0].strip() == "q")
        except ValueError:
            return False
    return False


@lru_cache(maxsize=16)
def compressed_static(path: str, mtime_ns: int, size: int) -> bytes:
    # mtime_ns and size are cache keys for static exports replaced during a build.
    return gzip.compress(Path(path).read_bytes(), compresslevel=4, mtime=0)


# ---------------------------------------------------------------- HTTP

class BusHandler(SimpleHTTPRequestHandler):
    admin = False  # set per listening port; admin endpoints spawn processes and edit the registry

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DASHBOARD_DIR), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        if args and isinstance(args[0], str) and "/api/snapshot" in args[0]:
            return
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _static_text_asset(self) -> bool:
        path = urlparse(self.path).path
        return path.startswith("/_next/static/") and path.endswith((".js", ".css"))

    def send_head(self):
        if (not self._static_text_asset() or not supports_gzip(self.headers.get("Accept-Encoding", ""))
                or self.headers.get("Range") or self.headers.get("If-Modified-Since")):
            return super().send_head()
        path = Path(self.translate_path(self.path))
        try:
            st = path.stat()
            if not path.is_file() or not 1024 <= st.st_size <= 1024 * 1024:
                return super().send_head()
            raw = compressed_static(str(path), st.st_mtime_ns, st.st_size)
        except OSError:
            return super().send_head()
        if len(raw) >= st.st_size:
            return super().send_head()
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(path)))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Last-Modified", self.date_time_string(st.st_mtime))
        self.end_headers()
        return io.BytesIO(raw)

    def end_headers(self) -> None:
        if self._static_text_asset():
            self.send_header("Vary", "Accept-Encoding")
        # Always revalidate the shell so phones pick up dashboard builds; hashed /_next/ assets are immutable.
        if self.path.startswith("/_next/static/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _send_json(self, code: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Vary", "Accept-Encoding")
        if supports_gzip(self.headers.get("Accept-Encoding", "")) and len(raw) >= 1024:
            packed = gzip.compress(raw, compresslevel=3, mtime=0)
            if len(packed) < len(raw):
                raw = packed
                self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:  # noqa: N802
        # No CORS: only same-origin pages (the dashboard itself) may call the API from a browser.
        self.send_response(204)
        self.end_headers()

    def request_allowed(self) -> bool:
        """Refuse DNS-rebinding hosts and cross-site browser requests; curl/bus_client send no Origin."""
        host = (self.headers.get("Host") or "").strip().lower()
        name = host.rsplit(":", 1)[0].strip("[]") if host else ""
        try:
            ipaddress.ip_address(name)
            host_ok = True
        except ValueError:
            host_ok = name in {"", "localhost", socket.gethostname().lower()} or name.endswith(".ts.net")
        origin = self.headers.get("Origin")
        origin_ok = origin is None or urlparse(origin).netloc.lower() == host
        if host_ok and origin_ok:
            return True
        self._send_json(403, {"error": "cross-site or unknown-host request refused"})
        return False

    def snapshot(self, after: str | None, cursor: str | None = None, tasks_after: str | None = None) -> dict[str, Any]:
        data = load_agents()
        with _EVENT_INDEX.lock:
            _EVENT_INDEX.refresh()
            out_events, full, last, event_cursor = _EVENT_INDEX.delta(after, cursor)
            tasks_revision = f"{_EVENT_INDEX.epoch}:{_EVENT_INDEX.task_revision}"
            task_fields = {} if tasks_after == tasks_revision else {"tasks": _EVENT_INDEX.tasks()}
            live_presence = presence(_EVENT_INDEX, data)
        telemetry = snapshot_telemetry()
        return {
            "agents": data.get("agents", []),
            "links": get_links(data),
            "events": out_events,
            "full": full,
            "last_id": last,
            "event_cursor": event_cursor,
            "tasks_revision": tasks_revision,
            **task_fields,
            "presence": live_presence,
            "machines": machine_status(data),
            "roles": {k: v for k, v in ROLE_PRESETS.items()},
            "channels": [],
            **telemetry,
            "memory": machine_memory(),
            "user_state": load_user_state(),
            "capabilities": {"admin": self.admin, "admin_url": f"http://{(self.headers.get('Host') or '127.0.0.1').rsplit(':', 1)[0]}:{ADMIN_PORT}/" if ADMIN_PORT else None},
            "clis": {k: {"label": v["label"], "available": bool(shutil.which(v["bin"], path=agent_path())),
                         "resume": v["resume"], "standard": v["standard"], "full": v["full"]} for k, v in CLI_PRESETS.items()},
            "limits": {"max_ttl_min": MAX_TTL_MIN, "max_active_temp": MAX_ACTIVE_TEMP, "summon_est_gib": SUMMON_EST_GIB,
                       "min_avail_after_gib": MIN_AVAIL_AFTER_GIB, "memory_max_gib": SUMMON_MEMORY_MAX_GIB},
            "generated_at": utc_now(),
        }

    def do_GET(self) -> None:  # noqa: N802
        if not self.request_allowed():
            return
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)
        if parsed.path == "/api/snapshot":
            self._send_json(200, self.snapshot(
                qs.get("after", [None])[0], qs.get("cursor", [None])[0], qs.get("tasks_after", [None])[0],
            ))
            return
        if parsed.path == "/api/events":
            self._send_json(200, read_events())
            return
        if parsed.path == "/api/messages/search":
            filters = {key: values[0] for key, values in qs.items()
                       if key in {"agent", "q", "task_id", "event_id", "before", "direction"}}
            if filters.setdefault("agent", "") == "user" and not self.admin:
                self._send_json(403, {"error": "USER mail search requires the local admin port"})
                return
            try:
                result = search_messages(**filters, limit=int(qs.get("limit", ["25"])[0]))
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, result)
            return
        if parsed.path == "/api/agents":
            self._send_json(200, load_agents())
            return
        if parsed.path == "/api/team":
            include_all = qs.get("all", ["0"])[0] in {"1", "true", "yes"}
            available_only = qs.get("available", ["0"])[0] in {"1", "true", "yes"}
            self._send_json(200, team_roster(include_all=include_all, available_only=available_only))
            return
        if parsed.path == "/api/tasks":
            with _EVENT_INDEX.lock:
                _EVENT_INDEX.refresh()
                tasks = _EVENT_INDEX.tasks()
            self._send_json(200, tasks)
            return
        if parsed.path == "/api/todo":
            from todo_store import TodoError

            try:
                self._send_json(200, todo_read({key: value[0] for key, value in qs.items()}, admin=self.admin))
            except TodoError as exc:
                self._send_json(exc.status, {"error": str(exc), "current": exc.current})
            return
        if parsed.path == "/api/attachments":
            try:
                limit = max(1, min(300, int(qs.get("limit", ["300"])[0])))
                offset = max(0, int(qs.get("offset", ["0"])[0]))
            except ValueError:
                self._send_json(400, {"error": "limit and offset must be integers"})
                return
            if qs.get("refresh", ["0"])[0] == "1" and self.admin:
                _ATTACHMENT_INDEX.invalidate()
            self._send_json(200, attachments_list(limit=limit, offset=offset))
            return
        if parsed.path == "/api/repo-dir":
            if not self.admin:
                self._send_json(403, {"error": "admin required"})
                return
            try:
                self._send_json(200, list_repo_dir(qs.get("path", [""])[0]))
            except FileNotFoundError as exc:
                self._send_json(404, {"error": str(exc)})
            return
        if parsed.path.startswith("/api/wait/"):
            agent_id = parsed.path.split("/")[3]
            try:
                timeout = max(1, min(120, int(qs.get("timeout", ["90"])[0])))
            except ValueError:
                timeout = 90
            deadline = time.time() + timeout
            while True:
                touch_polled(agent_id)
                items = inbox_for(agent_id)
                if items or agent_ended(find_agent(load_agents(), agent_id)) or time.time() >= deadline:
                    self._send_json(200, items if items or not agent_ended(find_agent(load_agents(), agent_id)) else {"ended": True})
                    return
                time.sleep(2)
        if parsed.path == "/bus_client.py":
            raw = (BUS_PY.parent / "bus_client.py").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/x-python; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if parsed.path.startswith("/api/agents/") and parsed.path.endswith("/instructions"):
            data = load_agents()
            a = find_agent(data, parsed.path.split("/")[3])
            if not a:
                self._send_json(404, {"error": "no such agent"})
                return
            self._send_json(200, {"agent": a["id"], "text": agent_instructions(a, data=data)})
            return
        if parsed.path.startswith("/api/sessions/") and parsed.path.endswith("/log"):
            agent_id = parsed.path.split("/")[3]
            self._send_json(200, {"agent": agent_id, "log": session_log(agent_id)})
            return
        if parsed.path.startswith("/attach/"):
            self.send_attachment(unquote(parsed.path[len("/attach/"):]))
            return
        if parsed.path.startswith("/repo/"):
            self.send_repo_file(unquote(parsed.path[len("/repo/"):]))
            return
        if parsed.path.startswith("/api/inbox/"):
            agent_id = parsed.path.split("/")[-1]
            unread = qs.get("all", ["0"])[0] not in {"1", "true", "yes"}
            touch_polled(agent_id)
            self._send_json(200, inbox_for(agent_id, unread_only=unread))
            return
        super().do_GET()

    def send_attachment(self, rel: str) -> None:
        parts = [p for p in rel.split("/") if p]
        if not parts or any(p.startswith(".") for p in parts):
            self._send_json(404, {"error": "no such attachment"})
            return
        try:
            f = ATTACH_DIR.joinpath(*parts).resolve()
            if not viewable_path(f, ATTACH_DIR):
                raise ValueError
        except (ValueError, OSError):
            self._send_json(404, {"error": "no such attachment"})
            return
        self._send_viewable(f)

    def send_repo_file(self, rel: str) -> None:
        """Show a supported file inside the configured workspace root."""
        parts = [p for p in rel.split("/") if p]
        if not parts or any(p.startswith(".") for p in parts):
            self._send_json(404, {"error": "no such file"})
            return
        if "/".join(parts).startswith(ATTACH_REF_PREFIX):
            self.send_attachment("/".join(parts)[len(ATTACH_REF_PREFIX):])
            return
        try:
            file = REPO_DIR.joinpath(*parts).resolve()
            if not viewable_path(file, REPO_DIR):
                raise ValueError
        except (ValueError, OSError):
            self._send_json(404, {"error": "no such file"})
            return
        self._send_viewable(file)

    def _send_viewable(self, f: Path) -> None:
        ext = f.suffix.lower()
        if not f.is_file() or (ext not in TEXT_EXT and ext not in MIME) or f.stat().st_size > VIEW_MAX_BYTES:
            self._send_json(404, {"error": "no such attachment"})
            return
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "text/plain; charset=utf-8"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        if not self.request_allowed():
            return
        if ingress_closed():
            self._send_json(503, {"error": "bus writes are paused for maintenance; retry shortly"})
            return
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        if parsed.path == "/api/attachments":
            # Browser upload from the mailroom composer (raw bytes + X-Filename header).
            if not self.admin:
                self._send_json(403, {"error": f"uploads are only accepted on the local admin port {ADMIN_PORT}"})
                return
            task_id = parse_qs(parsed.query).get("task_id", [None])[0]
            if task_id:
                from todo_store import TodoError

                try:
                    todo_read({"id": task_id}, admin=False)
                except TodoError as exc:
                    self._send_json(exc.status, {"error": str(exc)})
                    return
            try:
                saved = save_attachment(self.headers.get("X-Filename") or "", body)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            if task_id:
                try:
                    saved.update(todo_mutation({"action": "link", "id": task_id,
                                               "path": f"coordination/attachments/{saved['name']}"}, admin=True))
                except TodoError as exc:
                    saved["link_warning"] = f"File uploaded. {exc}"
            self._send_json(201, saved)
            return
        try:
            data = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid json"})
            return
        if parsed.path == "/api/todo":
            from todo_store import TodoError

            try:
                self._send_json(200, todo_mutation(data, admin=self.admin))
            except TodoError as exc:
                self._send_json(exc.status, {"error": str(exc), "current": exc.current})
            return

        if parsed.path == "/api/events":
            event = {
                "id": data.get("id"),
                "ts": utc_now() if data.get("from") == "user" else (data.get("ts") or utc_now()),
                "type": data.get("type") or "message",
                "from": data.get("from"),
                "to": data.get("to"),
                "cc": [c for c in (data.get("cc") or []) if isinstance(c, str)],
                "task_id": data.get("task_id"),
                "parent_task_id": data.get("parent_task_id"),
                "subject": data.get("subject"),
                "in_reply_to": data.get("in_reply_to"),
                "body": data.get("body") or "",
                "refs": data.get("refs") or [],
            }
            if event["type"] not in VALID_TYPES or not event["from"] or not event["to"]:
                self._send_json(400, {"error": "need type, from, to"})
                return
            if event["type"] == "agent.status":
                event["state"] = data.get("state") or "working"
            try:
                append_event(event)
            except PermissionError as exc:
                self._send_json(403, {"error": str(exc)})
                return
            self._send_json(201, event)
            return

        if parsed.path == "/api/mark-seen":
            agent_id = data.get("agent")
            event_id = data.get("event_id")
            if not agent_id:
                self._send_json(400, {"error": "need agent"})
                return
            if not event_id:
                evs = read_events()
                event_id = evs[-1]["id"] if evs else ""
            set_seen(agent_id, event_id)
            self._send_json(200, {"agent": agent_id, "seen": event_id})
            return

        if parsed.path == "/api/user-state":
            action = str(data.get("action"))
            if action in {"archive", "unarchive"} and not self.admin:
                self._send_json(403, {"error": "archive controls require the local admin port"})
                return
            try:
                st = update_user_state(action, [str(i) for i in data.get("ids") or []])
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self._send_json(200, st)
            return

        admin_routes = {"/api/agents", "/api/links", "/api/summon"}
        session_route = re.fullmatch(r"/api/sessions/([a-z][a-z0-9_.-]{0,31})/(stop|reference)", parsed.path)
        if parsed.path in admin_routes or session_route:
            if not self.admin:
                self._send_json(403, {"error": f"team controls are only on the local admin port {ADMIN_PORT}"})
                return
            try:
                if parsed.path == "/api/agents":
                    self._send_json(200, upsert_agent(data))
                elif parsed.path == "/api/links":
                    self._send_json(200, set_links(data.get("links") or []))
                elif parsed.path == "/api/summon":
                    self._send_json(201, summon(data))
                elif session_route[2] == "reference":
                    if not isinstance(data, dict):
                        raise ValueError("Expected a JSON object")
                    self._send_json(200, update_session_id(session_route[1], data.get("session_id"), data.get("previous_id")))
                else:
                    stop_temp_agent(session_route[1])
                    self._send_json(200, {"stopped": session_route[1]})
            except (ValueError, RuntimeError) as exc:
                self._send_json(400, {"error": str(exc)})
            except subprocess.SubprocessError as exc:
                self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "not found"})


ADMIN_PORT: int | None = None


def reaper_loop() -> None:
    while True:
        try:
            reap_temp_agents()
        except Exception as exc:  # keep serving even if systemctl hiccups
            sys.stderr.write(f"[reaper] {exc}\n")
        time.sleep(15)


def cmd_serve(args: argparse.Namespace) -> int:
    global ADMIN_PORT
    if not DASHBOARD_DIR.exists():
        print(f"missing dashboard at {DASHBOARD_DIR}", file=sys.stderr)
        return 1
    migrate_registry()
    init_user_state()
    global PUBLIC_PORT
    PUBLIC_PORT = args.port
    ADMIN_PORT = args.admin_port or None
    servers = [ThreadingHTTPServer((args.host, args.port), type("PublicHandler", (BusHandler,), {"admin": False}))]
    if ADMIN_PORT:
        # Not forwarded to machine B: only processes on machine A can summon agents or edit the team.
        servers.append(ThreadingHTTPServer(("127.0.0.1", ADMIN_PORT), type("AdminHandler", (BusHandler,), {"admin": True})))
    threading.Thread(target=reaper_loop, daemon=True).start()
    threading.Thread(target=probe_loop, daemon=True).start()
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"Mission control at http://{args.host}:{args.port}/ (agents, read + reply)", flush=True)
    if ADMIN_PORT:
        print(f"Command center at http://127.0.0.1:{ADMIN_PORT}/ (team, summon)", flush=True)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


def build_parser() -> argparse.ArgumentParser:
    from bus_client import add_todo_parser

    p = argparse.ArgumentParser(description="Agent message bus")
    sub = p.add_subparsers(dest="cmd", required=True)

    post = sub.add_parser("post", help="Append an event")
    post.add_argument("--from", dest="from_agent", required=True)
    post.add_argument("--to", required=True)
    post.add_argument("--cc", action="append", default=[], help="copy another agent (repeatable); routes apply to each")
    post.add_argument("--type", default="message")
    post.add_argument("--body", required=True)
    post.add_argument("--subject", default=None)
    post.add_argument("--in-reply-to", default=None, help="event id this message answers (threads the conversation)")
    post.add_argument("--task-id", default=None)
    post.add_argument("--parent-task-id", default=None)
    post.add_argument("--ref", action="append", default=[])
    post.add_argument("--state", default=None, help="for agent.status")
    post.add_argument("--id", default=None)
    post.add_argument("--ts", default=None)
    post.set_defaults(func=cmd_post)

    st = sub.add_parser("status", help="Update agent status + emit agent.status")
    st.add_argument("--agent", required=True)
    st.add_argument("--state", required=True, choices=["working", "idle", "waiting", "failed", "offline"])
    st.add_argument("--summary", required=True)
    st.add_argument("--task-id", default=None)
    st.set_defaults(func=cmd_status)

    inbox = sub.add_parser("inbox", help="Read messages addressed (to or cc) to an agent")
    inbox.add_argument("--agent", required=True)
    inbox.add_argument("--all", action="store_true", help="include already-seen")
    inbox.set_defaults(func=cmd_inbox)

    search = sub.add_parser("search", help="Search your sent and received messages")
    search.add_argument("--agent", required=True)
    search.add_argument("--q", default="")
    search.add_argument("--task-id")
    search.add_argument("--event-id")
    search.add_argument("--before")
    search.add_argument("--direction", choices=("both", "received", "sent"), default="both")
    search.add_argument("--limit", type=int, default=25)
    search.set_defaults(func=cmd_search)

    wait = sub.add_parser("wait", help="Block until unread messages arrive (or timeout)")
    wait.add_argument("--agent", required=True)
    wait.add_argument("--timeout", type=int, default=90)
    wait.set_defaults(func=cmd_wait)

    seen = sub.add_parser("mark-seen", help="Advance inbox cursor")
    seen.add_argument("--agent", required=True)
    seen.add_argument("--event-id", default=None)
    seen.set_defaults(func=cmd_mark_seen)

    dump = sub.add_parser("dump", help="Print full snapshot JSON")
    dump.set_defaults(func=cmd_dump)
    add_todo_parser(sub, local=True).set_defaults(func=cmd_todo)

    reg = sub.add_parser("register", help="Add or update a permanent agent in the registry")
    reg.add_argument("--id", required=True)
    reg.add_argument("--name")
    reg.add_argument("--role")
    reg.add_argument("--machine")
    reg.add_argument("--cli", choices=sorted(CLI_PRESETS))
    reg.add_argument("--session-id", dest="session_id")
    reg.add_argument("--workdir")
    reg.add_argument("--notes")
    reg.add_argument("--role-preset", dest="role_preset", choices=sorted(ROLE_PRESETS))
    reg.add_argument("--role-prompt", dest="role_prompt")
    reg.set_defaults(func=cmd_register)

    ins = sub.add_parser("instructions", help="Print an agent's standing instructions (role, bus usage, inbox watch loop)")
    ins.add_argument("--agent", required=True)
    ins.set_defaults(func=cmd_instructions)

    links = sub.add_parser("links", help="Print who may message whom")
    links.set_defaults(func=cmd_links)

    team = sub.add_parser(
        "team",
        help="List team members, roles, activity estimates, and configured registry routes",
        description=(
            "List registered team members with role, machine, live state, activity estimates, and "
            "configured registry routes (`links`/`peers`, with `state` reported separately). "
            f"`available` and `reachable` are {LISTENING_MIN}-minute activity estimates; a persistent "
            "watcher can refresh `listening` while an agent is `idle` or `waiting`, so this does not "
            "establish spare capacity."
        ),
    )
    team.add_argument("--all", action="store_true", help="include retired and ended agents")
    team.add_argument("--available", action="store_true", help="only list agents estimated available (15-min window)")
    team.set_defaults(func=cmd_team)

    serve = sub.add_parser("serve", help="Serve dashboard + API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8766)
    serve.add_argument("--admin-port", type=int, default=8768, help="local-only port with team/summon controls (0 = off)")
    serve.set_defaults(func=cmd_serve)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    write_cmds = {"post", "status", "mark-seen", "register"}
    is_write = args.cmd in write_cmds or (args.cmd == "todo" and getattr(args, "action", "") not in ("list", "show"))
    if is_write and ingress_closed():
        print("bus writes are paused for maintenance (ingress gate); retry shortly", file=sys.stderr)
        return INGRESS_CLOSED_EXIT
    if not BUS_DIR.is_dir():
        # Never create a fresh empty bus in the wrong place (e.g. the store moved or COORD_STORE typo).
        print(f"bus data folder not found: {BUS_DIR} (store {STORE_DIR}, from {STORE_SOURCE}); "
              "set COORD_STORE or see the Mailroom README", file=sys.stderr)
        return 2
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
