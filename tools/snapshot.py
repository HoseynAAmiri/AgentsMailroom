#!/usr/bin/env python3
"""One-committer snapshot of the agents-mailroom store into its LOCAL git history.

Only reviewed exports are tracked (a2 review, e1978):
  exports/events/eNNNNN-eNNNNN.jsonl  metadata projection of bus/events.jsonl (no bodies, no
                                       subjects; USER-involved events reduced to id/ts/type)
  exports/todo/tasks.safe.json         reviewed task fields only (no notes, next action, blocker,
                                       editor, links or message tags)
  attachments listed in review/attachments.allow (explicit reviewed manifest; empty by default)
  Mailroom source, README/.gitignore/hooks/tools
Raw events, cursors, sessions, registry, USER state, SQLite files and archives are NEVER added:
they stay in operational storage and in the verified rollback checkpoints outside git.
Paths are added explicitly (no `git add -A`); .gitignore and the pre-commit hook enforce the
same policy again. Never pushes (no remote).

Usage: tools/snapshot.py [--export-only] [--dry-run]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 512 * 1024
SHARD = 500
TEXT_EXT = {".md", ".txt", ".json", ".csv", ".tsv", ".py", ".sh", ".patch", ".diff", ".yml", ".yaml",
            ".toml", ".tex", ".bib", ".ts", ".tsx", ".mjs", ".css", ".svg"}
TEXT_NAMES = {"input2d", "input3d", ".gitignore"}
SKIP_PARTS = {"node_modules", ".next", "__pycache__", "build", "clean_build", "out", "sandbox"}
ROOT_FILES = ["README.md", ".gitignore", ".size-allowlist"]
TREES = ["mailroom"]                        # filtered by extension/size/skip rules
FIXED_TREES = [".githooks", "tools", "exports", "review"]
REVIEWED = ROOT / "review" / "attachments.allow"   # one attachments/<path> per line, reviewed


def user_involved(e: dict) -> bool:
    people = [e.get("from"), e.get("to"), *(e.get("cc") or [])]
    return "user" in people or e.get("type") == "human.needed"


def project(e: dict) -> dict:
    if user_involved(e):
        return {"id": e.get("id"), "ts": e.get("ts"), "type": e.get("type"), "user_involved": True}
    body = e.get("body") or ""
    return {
        "id": e.get("id"), "ts": e.get("ts"), "type": e.get("type"), "from": e.get("from"),
        "to": e.get("to"), "cc": e.get("cc") or [], "task_id": e.get("task_id"),
        "in_reply_to": e.get("in_reply_to"),
        "refs": [r for r in (e.get("refs") or []) if isinstance(r, dict) and r.get("kind") in ("file", "commit", "path")],
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(), "body_chars": len(body),
    }


def export_events() -> int:
    src = ROOT / "bus" / "events.jsonl"
    out = ROOT / "exports" / "events"
    out.mkdir(parents=True, exist_ok=True)
    shards: dict[str, list[str]] = {}
    n = 0
    for line in src.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        num = int(str(e["id"]).lstrip("e"))
        lo = (num - 1) // SHARD * SHARD + 1
        name = f"e{lo:05d}-e{lo + SHARD - 1:05d}.jsonl"
        shards.setdefault(name, []).append(json.dumps(project(e), ensure_ascii=False, sort_keys=True))
        n += 1
    for name, rows in shards.items():
        tmp = out / (name + ".tmp")
        tmp.write_text("\n".join(rows) + "\n", encoding="utf-8")
        tmp.replace(out / name)
    return n


SAFE_GOAL_FIELDS = ("id", "number", "title", "removed")
SAFE_TASK_FIELDS = ("id", "goal_id", "number", "position", "title", "state", "owner", "priority",
                    "decision", "revision", "updated", "removed")


def export_todo() -> None:
    db = ROOT / "todo" / "tasks.sqlite3"
    if not db.exists():
        return
    out = ROOT / "exports" / "todo"
    out.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    try:
        data = {
            "goals": [{k: r[k] for k in SAFE_GOAL_FIELDS} for r in src.execute("select * from goals order by number")],
            "tasks": [{k: r[k] for k in SAFE_TASK_FIELDS} for r in src.execute("select * from tasks order by goal_id, position")],
        }
    finally:
        src.close()
    tmp = out / "tasks.safe.json.tmp"
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(out / "tasks.safe.json")


def allowed_paths() -> list[str]:
    paths = [p for p in ROOT_FILES if (ROOT / p).is_file()]
    for tree in FIXED_TREES:
        paths += [p.relative_to(ROOT).as_posix() for p in (ROOT / tree).rglob("*")
                  if p.is_file() and not p.is_symlink() and not p.name.endswith(".tmp")]
    for tree in TREES:
        for p in (ROOT / tree).rglob("*"):
            rel = p.relative_to(ROOT)
            if (not p.is_file() or p.is_symlink() or SKIP_PARTS & set(rel.parts)
                    or any(part.startswith(".tmp_") or (part.startswith(".") and "-build." in part)
                           for part in rel.parts)):
                continue
            if (p.suffix.lower() in TEXT_EXT or p.name in TEXT_NAMES) and p.stat().st_size <= MAX_BYTES:
                paths.append(rel.as_posix())
    paths = sorted(set(paths))
    # second gate: drop anything the allow-list .gitignore excludes
    r = subprocess.run(["git", "-C", str(ROOT), "check-ignore", "--stdin", "-z"], input="\0".join(paths).encode(),
                       capture_output=True)
    ignored = set(x for x in r.stdout.decode().split("\0") if x)
    return [p for p in paths if p not in ignored]


def reviewed_attachments() -> list[str]:
    """Explicit reviewed manifest; these are .gitignored by default and force-added one by one."""
    out = []
    if REVIEWED.is_file():
        for line in REVIEWED.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            p = ROOT / line
            if (line and not line.startswith("#") and line.startswith("attachments/") and ".." not in line
                    and p.is_file() and not p.is_symlink() and p.stat().st_size <= MAX_BYTES):
                out.append(line)
    return out


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=check, capture_output=True, text=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--export-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    n = export_events()
    export_todo()
    print(f"exported {n} event projections")
    if a.export_only:
        return 0
    paths = allowed_paths()
    if a.dry_run:
        print("\n".join(paths + reviewed_attachments()))
        return 0
    for i in range(0, len(paths), 500):
        git("add", "--", *paths[i:i + 500])
    reviewed = reviewed_attachments()
    if reviewed:
        git("add", "-f", "--", *reviewed)
    # tracked files that were removed or modified inside the allowed trees
    git("add", "-u", "--", *[t for t in ROOT_FILES + FIXED_TREES + TREES if (ROOT / t).exists()])
    if git("diff", "--cached", "--quiet", check=False).returncode == 0:
        print("nothing to snapshot")
        return 0
    from datetime import datetime, timezone
    r = git("commit", "-q", "-m", "snapshot " + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), check=False)
    sys.stderr.write(r.stderr)
    if r.returncode != 0:
        return r.returncode
    print(git("log", "-1", "--format=%h %s").stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
