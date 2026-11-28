#!/usr/bin/env python3
"""Isolated local snapshot of an agents-mailroom store into a separate git-dir.

Only reviewed exports are tracked:
  exports/events/eNNNNN-eNNNNN.jsonl  metadata projection of bus/events.jsonl (no bodies, no
                                       subjects; USER-involved events reduced to id/ts/type)
  exports/todo/tasks.safe.json         reviewed task fields only (no notes, next action, blocker,
                                       editor, links or message tags)
  attachments listed in review/attachments.allow (explicit reviewed manifest; empty by default)
  Mailroom source, README/.gitignore/hooks/tools

Snapshot history uses an isolated GIT_DIR, its own index, its own info/exclude allow-list,
its own pre-commit guard (tools/store_precommit.py), and a push-refusing hook. It fails closed
if pointed at the work tree's .git directory, a source clone, or a repo with any remote.

Usage:
  tools/snapshot.py --init [--work-tree DIR] [--git-dir DIR]
  tools/snapshot.py --migrate-from OLD_GIT_DIR [--work-tree DIR] [--git-dir DIR]
  tools/snapshot.py [--work-tree DIR] [--git-dir DIR] [--export-only] [--dry-run]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

DEFAULT_WORK_TREE = Path(__file__).resolve().parents[1]
MAX_BYTES = 512 * 1024
SHARD = 500
TEXT_EXT = {
    ".md", ".txt", ".json", ".csv", ".tsv", ".py", ".sh", ".patch", ".diff",
    ".yml", ".yaml", ".toml", ".tex", ".bib", ".ts", ".tsx", ".mjs", ".css", ".svg",
}
TEXT_NAMES = {"input2d", "input3d", ".gitignore"}
SKIP_PARTS = {"node_modules", ".next", "__pycache__", "build", "clean_build", "out", "sandbox"}
ROOT_FILES = ["README.md", ".gitignore", ".size-allowlist"]
TREES = ["mailroom"]
FIXED_TREES = [".githooks", "tools", "exports", "review"]
POINTER_FILE = ".snapshot-git-dir"
SNAPSHOT_MARKER_KEY = "mailroom.snapshotRepo"

SNAPSHOT_EXCLUDE = """\
# Private store snapshot allow-list (evaluated independently of work-tree .gitignore).
/*
!/.gitignore
!/.size-allowlist
!/README.md
!/.githooks/
!/tools/

!/exports/
/exports/**
!/exports/**/
!/exports/events/*.jsonl
!/exports/todo/tasks.safe.json

!/attachments/
/attachments/**
!/attachments/**/
!/review/

!/mailroom/
/mailroom/**
!/mailroom/**/
!/mailroom/*.sh
!/mailroom/bus/*.py
!/mailroom/web/src/**
!/mailroom/web/*.json
!/mailroom/web/*.ts
!/mailroom/web/*.mjs
!/mailroom/web/*.md
!/mailroom/web/.gitignore
!/mailroom/web/public/*.svg
/mailroom/**/node_modules/
/mailroom/**/.next/
/mailroom/**/out/
/mailroom/**/__pycache__/
/mailroom/web/tsconfig.tsbuildinfo
/mailroom/**/.*-build.*/
/mailroom/**/.tmp_*/
/mailroom/sandbox/
"""

PRE_COMMIT_HOOK = """\
#!/usr/bin/env bash
set -euo pipefail
top=$(git rev-parse --show-toplevel)
exec python3 "$top/tools/store_precommit.py"
"""

PRE_PUSH_HOOK = """\
#!/usr/bin/env bash
echo "private snapshot repo is local-only: push refused" >&2
exit 1
"""


class SnapshotError(RuntimeError):
    """Fail-closed configuration or isolation error."""


def _slug(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", name).strip("-")
    return cleaned or "store"


def default_snapshot_git_dir(work_tree: Path) -> Path:
    resolved = work_tree.resolve()
    xdg = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")).expanduser()
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()[:12]
    return (xdg / "agents-mailroom" / "snapshots" / f"{_slug(resolved.name)}-{digest}.git").resolve()


def resolve_git_dir(work_tree: Path, explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env_dir = os.environ.get("MAILROOM_SNAPSHOT_GIT_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser().resolve()
    pointer = work_tree / POINTER_FILE
    if pointer.is_file():
        for line in pointer.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                p = Path(line).expanduser()
                return (p if p.is_absolute() else work_tree / p).resolve()
    return default_snapshot_git_dir(work_tree)


def _base_git_env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _git_env(git_dir: Path, work_tree: Path) -> dict[str, str]:
    env = _base_git_env()
    env["GIT_DIR"] = str(git_dir)
    env["GIT_WORK_TREE"] = str(work_tree)
    env["GIT_INDEX_FILE"] = str(git_dir / "index")
    return env


def _git_bare(git_dir: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", f"--git-dir={git_dir}", *args],
        env=_base_git_env(),
        check=check,
        capture_output=True,
        text=True,
    )


def git_run(git_dir: Path, work_tree: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", f"--git-dir={git_dir}", f"--work-tree={work_tree}", *args],
        cwd=str(work_tree),
        env=_git_env(git_dir, work_tree),
        check=check,
        capture_output=True,
        text=True,
    )


def _source_git_targets(work_tree: Path) -> list[Path]:
    targets = [(work_tree / ".git").resolve()]
    dotgit = work_tree / ".git"
    if dotgit.is_file():
        try:
            first = dotgit.read_text(encoding="utf-8").splitlines()[0].strip()
        except (OSError, IndexError):
            first = ""
        if first.startswith("gitdir:"):
            raw = first.split(":", 1)[1].strip()
            p = Path(raw)
            targets.append((p if p.is_absolute() else work_tree / p).resolve())
    return targets


def _overlaps(a: Path, b: Path) -> bool:
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def _check_no_remotes(git_dir: Path, label: str) -> None:
    if not (git_dir / "HEAD").is_file():
        raise SnapshotError(f"{label} is not a git repository (missing HEAD): {git_dir}")
    remotes = _git_bare(git_dir, "remote", check=False)
    if remotes.returncode != 0 or remotes.stdout.strip():
        raise SnapshotError(f"{label} has remotes configured or unreadable remote state: {git_dir}")
    remote_cfg = _git_bare(git_dir, "config", "--get-regexp", r"^remote\.", check=False)
    if remote_cfg.returncode == 0 and remote_cfg.stdout.strip():
        raise SnapshotError(f"{label} contains remote.* config entries: {git_dir}")
    remote_refs = _git_bare(git_dir, "for-each-ref", "refs/remotes", check=False)
    if remote_refs.returncode != 0 or remote_refs.stdout.strip():
        raise SnapshotError(f"{label} contains refs/remotes entries: {git_dir}")


def _resolve_git_path(git_dir: Path, raw: str) -> Path:
    p = Path(raw)
    return (p if p.is_absolute() else git_dir / p).resolve()


def _validate_git_paths_private(work_tree: Path, git_dir: Path) -> None:
    if git_dir.is_symlink():
        raise SnapshotError(f"refusing symlinked snapshot git-dir: {git_dir}")
    gd = git_dir.resolve()
    wt = work_tree.resolve()
    if (gd / "commondir").exists() or (gd / "commondir").is_symlink():
        raise SnapshotError(f"refusing snapshot git-dir with commondir indirection: {gd}")
    for rel in ("objects", "index", "info", "info/exclude", "hooks", "hooks/pre-commit", "hooks/pre-push"):
        if (gd / rel).is_symlink():
            raise SnapshotError(f"refusing symlink inside snapshot git-dir ({rel}): {gd}")
    alt = gd / "objects" / "info" / "alternates"
    if alt.exists() or alt.is_symlink():
        raise SnapshotError(f"refusing snapshot objects/info/alternates indirection: {gd}")

    rp = _git_bare(
        gd,
        "rev-parse",
        "--git-dir",
        "--git-common-dir",
        "--git-path",
        "objects",
        "--git-path",
        "index",
        "--git-path",
        "info/exclude",
        "--git-path",
        "hooks",
        check=False,
    )
    lines = rp.stdout.splitlines() if rp.returncode == 0 else []
    if len(lines) != 6:
        raise SnapshotError(f"unable to verify private git paths for {gd}: {rp.stderr.strip()}")
    r_gd, r_common, r_obj, r_idx, r_excl, r_hooks = (_resolve_git_path(gd, line) for line in lines)

    if r_gd != gd or r_common != gd:
        raise SnapshotError(f"refusing snapshot git-dir with shared common/git dir ({r_gd}, {r_common} != {gd})")
    if r_obj != (gd / "objects").resolve() or not r_obj.is_relative_to(gd):
        raise SnapshotError(f"refusing snapshot objects dir outside {gd}: {r_obj}")
    if r_idx != (gd / "index").resolve() or not r_idx.is_relative_to(gd):
        raise SnapshotError(f"refusing snapshot index outside {gd}: {r_idx}")
    if r_excl != (gd / "info" / "exclude").resolve() or not (gd / "info" / "exclude").is_file():
        raise SnapshotError(f"refusing missing or redirected info/exclude in {gd}: {r_excl}")
    if r_hooks != (gd / "hooks").resolve() or not r_hooks.is_relative_to(gd):
        raise SnapshotError(f"refusing snapshot hooks dir outside {gd}: {r_hooks}")

    forbidden = [wt, *_source_git_targets(wt)]
    for candidate in (r_gd, r_common, r_obj, r_idx, r_excl, r_hooks):
        for target in forbidden:
            if _overlaps(candidate, target):
                raise SnapshotError(f"refusing private git path {candidate} overlapping {target}")


def validate_git_dir_location(work_tree: Path, git_dir: Path) -> None:
    if git_dir.is_symlink():
        raise SnapshotError(f"refusing symlinked snapshot git-dir: {git_dir}")
    wt = work_tree.resolve()
    gd = git_dir.resolve()
    if gd == wt or wt.is_relative_to(gd):
        raise SnapshotError(f"refusing snapshot git-dir inside/equal to work-tree root: {gd}")
    for src in _source_git_targets(wt):
        if _overlaps(gd, src):
            raise SnapshotError(f"refusing snapshot git-dir overlapping work-tree .git ({src}): {gd}")
    if gd.parent == wt and gd.name == ".git":
        raise SnapshotError(f"refusing to target work-tree .git directly: {gd}")


def validate_snapshot_git_dir(work_tree: Path, git_dir: Path, *, allow_missing: bool = False) -> None:
    validate_git_dir_location(work_tree, git_dir)
    if allow_missing:
        return
    gd = git_dir.resolve()
    if not gd.is_dir():
        raise SnapshotError(f"snapshot git-dir does not exist (run --init or --migrate-from first): {gd}")
    _check_no_remotes(gd, "snapshot git-dir")
    _validate_git_paths_private(work_tree, gd)
    wt_cfg = _git_bare(gd, "config", "--get-all", "core.worktree", check=False)
    if wt_cfg.returncode == 0 and wt_cfg.stdout.strip():
        raise SnapshotError(f"refusing snapshot git-dir with core.worktree configured: {gd}")
    marker = _git_bare(gd, "config", "--get", SNAPSHOT_MARKER_KEY, check=False)
    if marker.returncode != 0 or marker.stdout.strip().lower() != "true":
        raise SnapshotError(f"refusing git-dir missing {SNAPSHOT_MARKER_KEY}=true: {gd}")
    hooks_cfg = _git_bare(gd, "config", "--get", "core.hooksPath", check=False)
    expected_hooks = (gd / "hooks").resolve()
    if hooks_cfg.returncode != 0 or not hooks_cfg.stdout.strip():
        raise SnapshotError(f"refusing snapshot git-dir without isolated core.hooksPath: {gd}")
    cfg_path = Path(hooks_cfg.stdout.strip())
    if not cfg_path.is_absolute():
        cfg_path = (gd / cfg_path).resolve()
    else:
        cfg_path = cfg_path.resolve()
    if cfg_path != expected_hooks:
        raise SnapshotError(f"refusing snapshot git-dir with unexpected core.hooksPath ({cfg_path} != {expected_hooks})")
    pre_commit = expected_hooks / "pre-commit"
    pre_push = expected_hooks / "pre-push"
    if not (pre_commit.is_file() and os.access(pre_commit, os.X_OK)):
        raise SnapshotError(f"missing executable snapshot pre-commit hook: {pre_commit}")
    if not (pre_push.is_file() and os.access(pre_push, os.X_OK)):
        raise SnapshotError(f"missing executable snapshot pre-push hook: {pre_push}")
    push_text = pre_push.read_text(encoding="utf-8", errors="replace")
    if "exit 1" not in push_text or "push refused" not in push_text:
        raise SnapshotError(f"refusing snapshot pre-push hook missing refusal guard: {pre_push}")


def configure_isolated_git_dir(git_dir: Path) -> None:
    gd = git_dir.resolve()
    (gd / "info").mkdir(parents=True, exist_ok=True)
    (gd / "info" / "exclude").write_text(SNAPSHOT_EXCLUDE, encoding="utf-8")
    hooks = gd / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    for name, content in (("pre-commit", PRE_COMMIT_HOOK), ("pre-push", PRE_PUSH_HOOK)):
        hook_path = hooks / name
        hook_path.write_text(content, encoding="utf-8")
        hook_path.chmod(0o755)
    _git_bare(gd, "config", "--unset-all", "core.worktree", check=False)
    _git_bare(gd, "config", "core.bare", "false")
    _git_bare(gd, "config", "core.hooksPath", str(hooks))
    _git_bare(gd, "config", SNAPSHOT_MARKER_KEY, "true")
    _git_bare(gd, "config", "user.name", "agents-mailroom")
    _git_bare(gd, "config", "user.email", "store@localhost")


def init_snapshot_repo(work_tree: Path, git_dir: Path) -> None:
    validate_snapshot_git_dir(work_tree, git_dir, allow_missing=True)
    gd = git_dir.resolve()
    if gd.exists():
        raise SnapshotError(f"target snapshot git-dir already exists: {gd}")
    gd.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "--bare", "--initial-branch=main", str(gd)],
        env=_base_git_env(),
        check=True,
        capture_output=True,
        text=True,
    )
    configure_isolated_git_dir(gd)


def migrate_snapshot_repo(work_tree: Path, git_dir: Path, old_git_dir: Path) -> str:
    validate_snapshot_git_dir(work_tree, git_dir, allow_missing=True)
    gd = git_dir.resolve()
    old = old_git_dir.resolve()
    if gd.exists():
        raise SnapshotError(f"target snapshot git-dir already exists: {gd}")
    if old == gd or gd.is_relative_to(old) or old.is_relative_to(gd):
        raise SnapshotError(f"refusing overlapping migrate source {old} and target {gd}")
    if not old.is_dir():
        raise SnapshotError(f"source snapshot git-dir does not exist: {old}")
    if (old / "commondir").exists() or (old / "objects").is_symlink() or (old / "objects" / "info" / "alternates").exists() or (old / "index").is_symlink():
        raise SnapshotError(f"refusing migration source git-dir with shared/symlinked internals: {old}")
    _check_no_remotes(old, "migration source git-dir")
    gd.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(old, gd, symlinks=True)
    try:
        configure_isolated_git_dir(gd)
        _check_no_remotes(gd, "migrated snapshot git-dir")
        head = _git_bare(gd, "rev-parse", "--verify", "HEAD")
    except Exception:
        shutil.rmtree(gd, ignore_errors=True)
        raise
    return head.stdout.strip()


def user_involved(e: dict) -> bool:
    people = [e.get("from"), e.get("to"), *(e.get("cc") or [])]
    return (
        "user" in people
        or e.get("type") in {"human.needed", "human.resolved"}
        or bool(e.get("resolved_by_click"))
    )


def project(e: dict) -> dict:
    if e.get("type") == "human.resolved" or e.get("resolved_by_click") is True:
        out: dict = {
            "id": e.get("id"),
            "ts": e.get("ts"),
            "type": e.get("type"),
            "user_involved": True,
            "in_reply_to": e.get("in_reply_to"),
            "resolved_by_click": True,
        }
        if e.get("task_id"):
            out["task_id"] = e.get("task_id")
        return out
    if user_involved(e):
        return {"id": e.get("id"), "ts": e.get("ts"), "type": e.get("type"), "user_involved": True}
    body = e.get("body") or ""
    return {
        "id": e.get("id"),
        "ts": e.get("ts"),
        "type": e.get("type"),
        "from": e.get("from"),
        "to": e.get("to"),
        "cc": e.get("cc") or [],
        "task_id": e.get("task_id"),
        "in_reply_to": e.get("in_reply_to"),
        "refs": [r for r in (e.get("refs") or []) if isinstance(r, dict) and r.get("kind") in ("file", "commit", "path")],
        "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "body_chars": len(body),
    }


def export_events(work_tree: Path) -> int:
    src = work_tree / "bus" / "events.jsonl"
    if not src.is_file():
        return 0
    out = work_tree / "exports" / "events"
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
SAFE_TASK_FIELDS = (
    "id", "goal_id", "number", "position", "title", "state", "owner",
    "priority", "decision", "revision", "updated", "done_at", "removed",
)


def export_todo(work_tree: Path) -> None:
    db = work_tree / "todo" / "tasks.sqlite3"
    if not db.exists():
        return
    out = work_tree / "exports" / "todo"
    out.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    try:
        task_cols = {r["name"] for r in src.execute("pragma table_info(tasks)")}
        data = {
            "goals": [{k: r[k] for k in SAFE_GOAL_FIELDS} for r in src.execute("select * from goals order by number")],
            "tasks": [{k: (r[k] if k in task_cols else "") for k in SAFE_TASK_FIELDS} for r in src.execute("select * from tasks order by goal_id, position")],
        }
    finally:
        src.close()
    tmp = out / "tasks.safe.json.tmp"
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(out / "tasks.safe.json")


def allowed_paths(work_tree: Path, git_dir: Path) -> list[str]:
    paths = [p for p in ROOT_FILES if (work_tree / p).is_file()]
    for tree in FIXED_TREES:
        base = work_tree / tree
        if not base.is_dir():
            continue
        paths += [
            p.relative_to(work_tree).as_posix()
            for p in base.rglob("*")
            if p.is_file() and not p.is_symlink() and not p.name.endswith(".tmp")
        ]
    for tree in TREES:
        base = work_tree / tree
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            rel = p.relative_to(work_tree)
            if (
                not p.is_file()
                or p.is_symlink()
                or SKIP_PARTS & set(rel.parts)
                or any(
                    part.startswith(".tmp_") or (part.startswith(".") and "-build." in part)
                    for part in rel.parts
                )
            ):
                continue
            if (p.suffix.lower() in TEXT_EXT or p.name in TEXT_NAMES) and p.stat().st_size <= MAX_BYTES:
                paths.append(rel.as_posix())
    paths = sorted(set(paths))
    if not paths:
        return []
    # Evaluate ignore rules exclusively against <git_dir>/info/exclude using an empty work tree so
    # work-tree .gitignore (owned by the upstream clone after B1) never interferes.
    with tempfile.TemporaryDirectory() as empty_wt:
        r = subprocess.run(
            [
                "git",
                f"--git-dir={git_dir}",
                f"--work-tree={empty_wt}",
                "-c",
                "core.excludesFile=/dev/null",
                "check-ignore",
                "--stdin",
                "-z",
            ],
            input="\0".join(paths).encode("utf-8"),
            env=_git_env(git_dir, Path(empty_wt)),
            capture_output=True,
        )
    if r.returncode not in (0, 1):
        detail = r.stderr.decode("utf-8", errors="replace").strip()
        raise SnapshotError(f"git check-ignore failed (exit {r.returncode}): {detail}")
    ignored = {x for x in r.stdout.decode("utf-8").split("\0") if x}
    return [p for p in paths if p not in ignored]


def reviewed_attachments(work_tree: Path) -> list[str]:
    """Explicit reviewed manifest; these stay excluded unless force-added one by one."""
    reviewed = work_tree / "review" / "attachments.allow"
    att_root = work_tree / "attachments"
    att_resolved = att_root.resolve()
    out = []
    if reviewed.is_file():
        for line in reviewed.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or not line.startswith("attachments/") or ".." in Path(line).parts:
                continue
            raw_p = work_tree / line
            # Check raw_p and all intermediate parents under attachments/ BEFORE resolve().
            cur = raw_p
            symlinked = False
            while cur != att_root and cur != work_tree:
                if cur.is_symlink():
                    symlinked = True
                    break
                cur = cur.parent
            if symlinked or att_root.is_symlink():
                continue
            p = raw_p.resolve()
            if p.is_relative_to(att_resolved) and p.is_file() and not raw_p.is_symlink():
                if p.stat().st_size <= MAX_BYTES:
                    out.append(line)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-tree", default=str(DEFAULT_WORK_TREE))
    ap.add_argument("--git-dir", default=None)
    ap.add_argument("--init", action="store_true")
    ap.add_argument("--migrate-from", default=None)
    ap.add_argument("--export-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)

    work_tree = Path(a.work_tree).expanduser().resolve()
    git_dir = resolve_git_dir(work_tree, a.git_dir)

    try:
        if a.init and a.migrate_from:
            raise SnapshotError("pass either --init or --migrate-from, not both")
        if a.init:
            init_snapshot_repo(work_tree, git_dir)
            print(f"initialized isolated snapshot git-dir: {git_dir}")
            return 0
        if a.migrate_from:
            head = migrate_snapshot_repo(work_tree, git_dir, Path(a.migrate_from).expanduser())
            print(f"migrated isolated snapshot git-dir: {git_dir} (HEAD {head[:7]})")
            return 0
        if a.export_only:
            validate_git_dir_location(work_tree, git_dir)
            n = export_events(work_tree)
            export_todo(work_tree)
            print(f"exported {n} event projections")
            return 0
        validate_snapshot_git_dir(work_tree, git_dir)
        n = export_events(work_tree)
        export_todo(work_tree)
        print(f"exported {n} event projections")

        paths = allowed_paths(work_tree, git_dir)
        reviewed = reviewed_attachments(work_tree)
    except SnapshotError as exc:
        print(f"snapshot error: {exc}", file=sys.stderr)
        return 2

    if a.dry_run:
        print("\n".join(paths + reviewed))
        return 0

    for i in range(0, len(paths), 500):
        git_run(git_dir, work_tree, "add", "-f", "--", *paths[i:i + 500])
    if reviewed:
        git_run(git_dir, work_tree, "add", "-f", "--", *reviewed)
    tracked_tops = {
        p.split("/", 1)[0]
        for p in git_run(git_dir, work_tree, "ls-files", "-z").stdout.split("\0")
        if p
    }
    tracked_roots = [t for t in ROOT_FILES + FIXED_TREES + TREES + ["attachments"] if t in tracked_tops]
    if tracked_roots:
        git_run(git_dir, work_tree, "add", "-u", "--", *tracked_roots)
    if git_run(git_dir, work_tree, "diff", "--cached", "--quiet", check=False).returncode == 0:
        print("nothing to snapshot")
        return 0
    r = git_run(
        git_dir,
        work_tree,
        "commit",
        "-q",
        "-m",
        "snapshot " + datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        check=False,
    )
    sys.stderr.write(r.stderr)
    if r.returncode != 0:
        return r.returncode
    print(git_run(git_dir, work_tree, "log", "-1", "--format=%h %s").stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
