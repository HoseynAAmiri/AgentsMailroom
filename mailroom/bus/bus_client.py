#!/usr/bin/env python3
"""HTTP client for the agent bus, for agents on another machine (stdlib only).

Same commands as bus.py, talking to the bus server instead of the files:
  python3 bus_client.py team [--available] [--all]
  python3 bus_client.py inbox --agent worker
  python3 bus_client.py search --agent worker --q "keywords" [--task-id R1]
  python3 bus_client.py post --from worker --to coordinator --body "..." [--cc reviewer] [--in-reply-to e123] [--task-id R1] [--ref file:...]
  python3 bus_client.py wait --agent worker --timeout 90
  python3 bus_client.py mark-seen --agent worker [--event-id e123]
  python3 bus_client.py status --agent worker --state working --summary "..."
The server defaults to http://127.0.0.1:8766 (local server or a configured SSH tunnel); override with BUS_URL.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

BUS_URL = os.environ.get("BUS_URL", "http://127.0.0.1:8766").rstrip("/")


def call(method, path, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BUS_URL + path, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"bus refused ({exc.code}): {detail}", file=sys.stderr)
        sys.exit(3)
    except urllib.error.URLError as exc:
        print(f"bus unreachable at {BUS_URL}: {exc.reason} (check the local service or SSH tunnel)", file=sys.stderr)
        sys.exit(4)


def add_todo_parser(sub, *, local=False):
    todo = sub.add_parser("todo", help="Read and update the goal tracker")
    commands = todo.add_subparsers(dest="action", required=True)
    names = ["list", "show", "add", "update", "link"]
    if local:
        names += ["seed", "export", "goal-add", "goal-update", "goal-remove", "remove", "move", "unlink", "tag"]
    for name in names:
        command = commands.add_parser(name)
        if name in {"show", "update", "link", "unlink", "goal-update", "goal-remove", "remove", "move"}:
            command.add_argument("id")
        if name in {"add", "update", "link"}:
            command.add_argument("--agent", required=not local)
        if name in {"add", "goal-add", "goal-update"}:
            command.add_argument("--title", required=True)
        if name == "add":
            command.add_argument("--goal-id", required=True)
        if name in {"add", "update"}:
            command.add_argument("--state", choices=("todo", "doing", "blocked", "done"))
            command.add_argument("--next-action")
            command.add_argument("--blocker")
            if local or name == "add":
                command.add_argument("--owner")
        if name in {"add", "update"} and local:
            if name == "update":
                command.add_argument("--title")
            command.add_argument("--priority", choices=("high", "normal", "low"))
            command.add_argument("--decision", action=argparse.BooleanOptionalAction)
            command.add_argument("--notes")
        if name in {"update", "goal-update", "goal-remove", "remove"}:
            command.add_argument("--revision", required=True, type=int)
        if name == "goal-remove":
            command.add_argument("--confirm-count", type=int)
        if name == "move":
            command.add_argument("--order-revision", required=True, type=int)
            command.add_argument("--direction", required=True, choices=("up", "down", "top"))
        if name in {"link", "unlink"}:
            command.add_argument("--path", required=True)
        if name == "tag":
            command.add_argument("--event-id", required=True)
            command.add_argument("--id", help="Omit to clear the task tag")
        if name == "seed":
            command.add_argument("--dry-run", action="store_true")
    return todo


def todo_payload(args):
    return {key: value for key, value in vars(args).items() if key not in {"cmd", "func"} and value is not None}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    add_todo_parser(sub)
    inbox = sub.add_parser("inbox")
    inbox.add_argument("--agent", required=True)
    inbox.add_argument("--all", action="store_true")
    search = sub.add_parser("search", help="Search your sent and received messages")
    search.add_argument("--agent", required=True)
    search.add_argument("--q")
    search.add_argument("--task-id")
    search.add_argument("--event-id")
    search.add_argument("--before")
    search.add_argument("--direction", choices=("both", "received", "sent"))
    search.add_argument("--limit", type=int)
    post = sub.add_parser("post")
    post.add_argument("--from", dest="from_agent", required=True)
    post.add_argument("--to", required=True)
    post.add_argument("--cc", action="append", default=[])
    post.add_argument("--type", default="message")
    post.add_argument("--body", required=True)
    post.add_argument("--subject")
    post.add_argument("--in-reply-to")
    post.add_argument("--task-id")
    post.add_argument("--parent-task-id")
    post.add_argument("--ref", action="append", default=[])
    post.add_argument("--state")
    wait = sub.add_parser("wait")
    wait.add_argument("--agent", required=True)
    wait.add_argument("--timeout", type=int, default=90)
    seen = sub.add_parser("mark-seen")
    seen.add_argument("--agent", required=True)
    seen.add_argument("--event-id")
    st = sub.add_parser("status")
    st.add_argument("--agent", required=True)
    st.add_argument("--state", required=True, choices=["working", "idle", "waiting", "failed", "offline"])
    st.add_argument("--summary", required=True)
    st.add_argument("--task-id")
    team = sub.add_parser("team", help="List team members, roles, availability, and allowed routes")
    team.add_argument("--all", action="store_true", help="include retired and ended agents")
    team.add_argument("--available", action="store_true", help="only list currently available agents")
    a = p.parse_args(argv)

    if a.cmd == "todo":
        if a.action in {"list", "show"}:
            out = call("GET", "/api/todo" + ("?" + urlencode({"id": a.id}) if a.action == "show" else ""))
        else:
            out = call("POST", "/api/todo", todo_payload(a))
    elif a.cmd == "inbox":
        out = call("GET", f"/api/inbox/{a.agent}" + ("?all=1" if a.all else ""))
    elif a.cmd == "search":
        query = {key: value for key, value in vars(a).items() if key != "cmd" and value is not None}
        out = call("GET", "/api/messages/search?" + urlencode(query))
    elif a.cmd == "post":
        if a.from_agent == "user":
            print("posting as 'user' is reserved for USER's mailroom", file=sys.stderr)
            return 3
        refs = []
        for r in a.ref:
            kind, _, value = r.partition(":")
            refs.append({"kind": kind.strip(), "value": value.strip()})
        out = call("POST", "/api/events", {
            "type": a.type, "from": a.from_agent, "to": a.to, "cc": a.cc, "body": a.body, "subject": a.subject,
            "in_reply_to": a.in_reply_to, "task_id": a.task_id, "parent_task_id": a.parent_task_id, "refs": refs, "state": a.state,
        })
    elif a.cmd == "wait":
        out = call("GET", f"/api/wait/{a.agent}?timeout={a.timeout}", timeout=a.timeout + 30)
    elif a.cmd == "mark-seen":
        out = call("POST", "/api/mark-seen", {"agent": a.agent, "event_id": a.event_id})
    elif a.cmd == "team":
        params = {}
        if a.all:
            params["all"] = "1"
        if a.available:
            params["available"] = "1"
        out = call("GET", "/api/team" + ("?" + urlencode(params) if params else ""))
    else:
        out = call("POST", "/api/events", {"type": "agent.status", "from": a.agent, "to": "*", "state": a.state, "body": a.summary, "task_id": a.task_id})
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
