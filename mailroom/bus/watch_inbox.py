#!/usr/bin/env python3
"""Check one agent's unread bus inbox and queue one Codex wake for new IDs.

Run once per minute from the user's crontab. Never marks messages as read,
sends bus messages, or starts an additional agent.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--thread", required=True)
    parser.add_argument("--codex", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    kit_bus = Path(__file__).resolve().parent
    repo = kit_bus.parent.parent
    sys.path.insert(0, str(kit_bus))
    from coord_store import resolve_store
    store, _ = resolve_store()
    env = {**os.environ, "COORD_STORE": str(store)}
    # Lock/state live next to the bus data, where bus.py looks for .inbox-watch-* files.
    bus_dir = Path(os.environ.get("BUS_DATA_DIR") or store / "bus")
    # Keep one lock/state per recipient conversation, even across cron overlap.
    stem = ".inbox-watch-" + args.agent + "-" + args.thread
    if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in stem[1:]):
        parser.error("agent and thread must be safe identifiers")
    with (bus_dir / (stem + ".lock")).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        result = subprocess.run(
            [sys.executable, str(kit_bus / "bus.py"), "inbox", "--agent", args.agent],
            cwd=repo, env=env, capture_output=True, text=True, timeout=15, check=True,
        )
        items = json.loads(result.stdout)
        state_path = bus_dir / (stem + ".json")
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        notified = set(state.get("notified_ids", []))
        fresh = [item for item in items if item["id"] not in notified]
        if not fresh:
            return 0
        ids = [item["id"] for item in fresh]
        prompt = (
            args.agent + ": unread " + ", ".join(ids)
            + ". Check the Mailroom inbox with python3 mailroom/bus/bus.py inbox --agent "
            + args.agent + ". Handle unread messages under current USER rules; reply, "
            "and mark handled messages seen. No new authority."
        )
        if args.dry_run:
            print(json.dumps({"new_ids": ids, "prompt": prompt}))
            return 0
        queued = subprocess.run(
            [args.codex, "queue", "--thread", args.thread, "--message", prompt, "--resume"],
            cwd=repo, capture_output=True, text=True, timeout=45, check=True,
        )
        # Only remember IDs after queue succeeds; failures get retried next tick.
        notified.update(ids)
        now = datetime.now(timezone.utc).isoformat()
        state = {"notified_ids": sorted(notified), "last_queued_at": now, "thread": args.thread}
        tmp = state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2) + "\n")
        tmp.replace(state_path)
        print(now + " queued " + ",".join(ids), flush=True)
        if queued.stdout.strip():
            print(queued.stdout.strip(), flush=True)
        if queued.stderr.strip():
            print(queued.stderr.strip(), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        print(datetime.now(timezone.utc).isoformat() + " inbox watcher failed: " + str(exc), file=sys.stderr)
        sys.exit(1)
