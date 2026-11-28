"""Pluggable database abstraction layer for Mailroom task tracking and synced repository files.

Mailroom bus, HTTP serving, and document discovery interact with persistence strictly through
`MailroomDatabase`, allowing either the built-in SQLite + content-addressed blob backend or a
user-hosted remote backend (`HttpDatabase` or custom `register_backend` / `MAILROOM_DB_BACKEND`).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
import base64
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tempfile
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

GOAL = re.compile(r"G([1-9][0-9]{0,8})")
TASK = re.compile(r"(G[1-9][0-9]{0,8})\.([1-9][0-9]{0,8})")
STATES = ("todo", "doing", "blocked", "done")
PRIORITIES = ("high", "normal", "low")
TITLES = re.compile(r"^## (?:Goal (\d+)\. (.+)|Cross-cutting: (.+) \(proposed Goal (\d+)\))$")
SEED_TASK = re.compile(r"^- (G\d+)\.(\d+) `\[([x~? ])\]` (.+)$")
HOST_PATH = re.compile(r"(?<![\w/])(?:/(?:home|mnt|tmp|Users|root|run/user)/|[A-Za-z]:\\Users\\)[^\s<>\"'`]+")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ATTACH_REF_PREFIX = "coordination/attachments/"
MAX_SYNC_FILE_BYTES = 64 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL, order_revision INTEGER NOT NULL,
    cutover INTEGER NOT NULL, cutover_time TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1, removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id),
    number INTEGER NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'todo' CHECK(state IN ('todo','doing','blocked','done')),
    owner TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('high','normal','low')),
    next_action TEXT NOT NULL DEFAULT '', blocker TEXT NOT NULL DEFAULT '',
    decision INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL,
    done_at TEXT NOT NULL DEFAULT '', editor TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0, UNIQUE(goal_id,number)
);
CREATE INDEX IF NOT EXISTS ordered_tasks ON tasks(goal_id,removed,position);
CREATE TABLE IF NOT EXISTS links (
    task_id TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, editor TEXT NOT NULL,
    PRIMARY KEY(task_id,path)
);
CREATE TABLE IF NOT EXISTS tags (
    event_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS file_records (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    source_commit TEXT NOT NULL DEFAULT '',
    source_blob TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL,
    editor TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS file_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    source_ref TEXT NOT NULL DEFAULT '',
    source_commit TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT '',
    file_count INTEGER NOT NULL DEFAULT 0,
    editor TEXT NOT NULL DEFAULT ''
);
"""

_FILE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS file_records (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    source_commit TEXT NOT NULL DEFAULT '',
    source_blob TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL,
    editor TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS file_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    source_ref TEXT NOT NULL DEFAULT '',
    source_commit TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT '',
    file_count INTEGER NOT NULL DEFAULT 0,
    editor TEXT NOT NULL DEFAULT ''
);
"""


class TodoError(ValueError):
    def __init__(self, message: str, status: int = 400, current: Any = None):
        super().__init__(message)
        self.status = status
        self.current = current


DatabaseError = TodoError


class BlobIntegrityError(TodoError):
    def __init__(self, message: str, status: int = 500, current: Any = None):
        super().__init__(message, status=status, current=current)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_sha256(value: Any, label: str = "sha256") -> str:
    text = str(value or "").strip().lower()
    if not SHA256_RE.fullmatch(text):
        raise TodoError(f"Invalid {label}")
    return text


def seed_rows(roadmap: Path) -> tuple[dict[str, tuple[int, str]], list[tuple[str, str, int, str, str]]]:
    goals: dict[str, tuple[int, str]] = {}
    tasks: list[tuple[str, str, int, str, str]] = []
    for line in roadmap.read_text(encoding="utf-8").splitlines():
        header = TITLES.fullmatch(line)
        if header:
            number, title, cross, cross_number = header.groups()
            num_i = int(number or cross_number)
            key = f"G{num_i}"
            if key in goals:
                raise TodoError(f"Duplicate roadmap goal {key}")
            goals[key] = (num_i, title or cross)
        row = SEED_TASK.fullmatch(line)
        if row:
            goal, number, mark, title = row.groups()
            tasks.append((f"{goal}.{number}", goal, int(number), title, mark))
    if not goals or not tasks or any(goal not in goals for _, goal, *_ in tasks):
        raise TodoError("The roadmap has missing goals or tasks")
    if len({key for key, *_ in tasks}) != len(tasks):
        raise TodoError("The roadmap contains duplicate task IDs")
    return goals, tasks


def text_field(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        raise TodoError(f"{label} must be text of up to {maximum} characters")
    return value.strip()


def relative_file(value: Any) -> str:
    raw = text_field(value, "File path", 500)
    path = PurePosixPath(raw)
    if (
        not raw
        or path.is_absolute()
        or ":" in raw
        or "\\" in raw
        or any(c in raw for c in "\r\n")
        or any(part.startswith(".") for part in path.parts)
        or not path.suffix
    ):
        raise TodoError("Use a repository-relative file path")
    return path.as_posix()


def task_title(values: dict[str, Any]) -> str:
    title = text_field(values.get("title"), "Title", 800)
    if not title or "\n" in title or "\r" in title:
        raise TodoError("Enter a one-line title")
    return title


def validate_task_fields(values: dict[str, Any], owners: set[str], admin: bool, creating: bool = False) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    admin_keys = {"title", "owner", "priority", "decision", "notes"}
    if not admin and (admin_keys - ({"title", "owner"} if creating else set())).intersection(values):
        raise TodoError("Those fields can only be changed by USER", 403)
    for key, limit in (
        ("owner", 80),
        ("state", 12),
        ("priority", 12),
        ("next_action", 2000),
        ("blocker", 2000),
        ("notes", 8000),
    ):
        if key in values:
            fields[key] = text_field(values[key], key, limit)
    if "title" in values:
        fields["title"] = task_title(values)
    for key, options in (("owner", owners | {"", "user"}), ("state", STATES), ("priority", PRIORITIES)):
        if key in fields and fields[key] not in options:
            raise TodoError(f"Invalid {key}")
    if "decision" in values:
        if type(values["decision"]) is not bool:
            raise TodoError("decision must be a boolean")
        fields["decision"] = int(values["decision"])
        if fields["decision"]:
            fields["state"] = "blocked"
    return fields


class MailroomDatabase(ABC):
    """Backend interface isolating all Mailroom persistence and file sync/serving."""

    @abstractmethod
    def backend_info(self) -> dict[str, Any]:
        """Return safe descriptive metadata about this backend (no host paths)."""

    @abstractmethod
    def initialized(self) -> bool:
        """Return True if the task tracker database has been initialized."""

    @abstractmethod
    def seed(
        self,
        goals: dict[str, tuple[int, str]],
        tasks: list[tuple[str, str, int, str, str]],
        cutover: int,
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Initialize schema and seed goals/tasks from parsed roadmap data."""

    @abstractmethod
    def list_state(self, *, include_links: bool = False) -> dict[str, Any]:
        """Return goals, tasks, revisions, and sync metadata."""

    @abstractmethod
    def mail_index(self, *, include_tags: bool) -> dict[str, Any]:
        """Return lightweight task index and optional event tags."""

    @abstractmethod
    def activity(self, task_id: str | None = None) -> tuple[dict[str, str], list[str]]:
        """Return `(event_tag_map, linked_paths_for_task)`."""

    @abstractmethod
    def linked_paths(self) -> set[str]:
        """Return distinct repository-relative links on active tasks."""

    @abstractmethod
    def task_membership(self) -> tuple[set[str], set[str], dict[str, str]] | None:
        """Return `(active_task_ids, retired_task_ids, tag_overrides)` or None if uninitialized."""

    @abstractmethod
    def mutate(self, values: dict[str, Any], editor: str, owners: set[str]) -> dict[str, Any]:
        """Apply an atomic tracker mutation and return `{"item": ...}`."""

    @abstractmethod
    def upsert_files(
        self,
        items: list[dict[str, Any]],
        *,
        prune_prefixes: tuple[str, ...] = (),
        keep_paths: Iterable[str] | None = None,
        update_sync_state: bool = True,
        source_ref: str = "",
        source_commit: str = "",
        editor: str = "",
        content_loader: Callable[[str, str], bytes] | None = None,
    ) -> dict[str, Any]:
        """Persist synced file metadata and verified immutable content blobs."""

    @abstractmethod
    def get_file_record(self, path: str) -> dict[str, Any] | None:
        """Return metadata for a DB-recorded repo path, or None."""

    @abstractmethod
    def has_blob(self, sha256: str) -> bool:
        """Return True if the content-addressed blob for `sha256` is stored."""

    @abstractmethod
    def store_verified_blob(self, sha256: str, content: bytes) -> None:
        """Verify `sha256` of `content` and persist it in blob storage."""

    @abstractmethod
    def read_file_content(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        """Return `(record, verified_bytes)` for `path`, or None if unrecorded."""

    @abstractmethod
    def list_file_records(self, prefix: str = "") -> list[dict[str, Any]]:
        """Return all `file_records` entries matching `prefix`."""

    @abstractmethod
    def file_sync_status(self) -> dict[str, Any]:
        """Return latest `file_sync_state` summary."""


class SqliteDatabase(MailroomDatabase):
    """Default local SQLite backend with content-addressed `todo/blobs/` storage."""

    def __init__(self, db_path: Path | str, *, blob_dir: Path | str | None = None):
        self.db = Path(db_path)
        self.blob_dir = Path(blob_dir) if blob_dir is not None else (self.db.parent / "blobs")

    def backend_info(self) -> dict[str, Any]:
        return {"kind": "sqlite", "scheme": "sqlite", "db_name": self.db.name}

    def blob_path(self, sha256: str) -> Path:
        digest = validate_sha256(sha256)
        return self.blob_dir / digest[:2] / digest

    def has_blob(self, sha256: str) -> bool:
        digest = validate_sha256(sha256)
        bp = self.blob_dir / digest[:2] / digest
        return bp.is_file()

    def store_verified_blob(self, sha256: str, content: bytes) -> None:
        digest = validate_sha256(sha256)
        actual = hashlib.sha256(content).hexdigest()
        if actual != digest:
            raise BlobIntegrityError(f"Blob digest mismatch: expected {digest}, got {actual}")
        bp = self.blob_path(digest)
        if bp.is_file():
            try:
                existing = bp.read_bytes()
                if len(existing) == len(content) and hashlib.sha256(existing).hexdigest() == digest:
                    return
            except OSError:
                pass
        bp.parent.mkdir(parents=True, exist_ok=True)
        tmp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=bp.parent, prefix=".blob-", delete=False, mode="wb"
            ) as tmp:
                tmp_path = Path(tmp.name)
                tmp.write(content)
            tmp_path.chmod(0o444)
            os.replace(tmp_path, bp)
        finally:
            if tmp_path is not None:
                tmp_path.unlink(missing_ok=True)

    def connect(self) -> sqlite3.Connection:
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        self._ensure_migrations(conn)
        return conn

    @staticmethod
    def _ensure_migrations(conn: sqlite3.Connection) -> None:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone():
            return
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)")}
        if "done_at" not in cols:
            with conn:
                conn.execute("ALTER TABLE tasks ADD COLUMN done_at TEXT NOT NULL DEFAULT ''")
                conn.execute("UPDATE tasks SET done_at=updated WHERE state='done' AND done_at=''")
        has_fr = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_records'").fetchone()
        has_fs = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_sync_state'").fetchone()
        if not has_fr or not has_fs:
            conn.executescript(_FILE_TABLES_SQL)

    def initialized(self) -> bool:
        return self.db.is_file()

    def seed(
        self,
        goals: dict[str, tuple[int, str]],
        tasks: list[tuple[str, str, int, str, str]],
        cutover: int,
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        if dry_run:
            return {"goals": list(goals), "tasks": [row[0] for row in tasks]}
        with closing(self.connect()) as conn:
            conn.executescript(SCHEMA)
            with conn:
                stamp = now()
                cursor = conn.execute("INSERT OR IGNORE INTO metadata VALUES (1,1,1,?,?,?)", (cutover, stamp, stamp))
                created = cursor.rowcount > 0
                if created:
                    conn.executemany(
                        "INSERT INTO goals(id,number,title) VALUES (?,?,?)",
                        ((key, *values) for key, values in goals.items()),
                    )
                    conn.executemany(
                        """INSERT INTO tasks(id,goal_id,number,position,title,state,decision,updated,done_at,editor)
                           VALUES (?,?,?,?,?,?,?,?,?, 'seed')""",
                        (
                            (
                                key,
                                goal,
                                number,
                                number,
                                title,
                                {" ": "todo", "~": "doing", "?": "blocked", "x": "done"}[mark],
                                int(mark == "?"),
                                stamp,
                                stamp if mark == "x" else "",
                            )
                            for key, goal, number, title, mark in tasks
                        ),
                    )
        return {"seeded": created}

    def list_state(self, *, include_links: bool = False) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            meta = conn.execute("SELECT * FROM metadata WHERE singleton=1").fetchone()
            if not meta:
                raise TodoError("Goal tracking has not been seeded", 503)
            goals = [dict(row) for row in conn.execute("SELECT * FROM goals WHERE removed=0 ORDER BY number")]
            tasks = [
                dict(row)
                for row in conn.execute(
                    """SELECT tasks.* FROM tasks JOIN goals ON goals.id=tasks.goal_id
                       WHERE tasks.removed=0 AND goals.removed=0 ORDER BY goals.number, tasks.position"""
                )
            ]
            if include_links:
                links_by_task: dict[str, list[str]] = {}
                for row in conn.execute("SELECT task_id, path FROM links ORDER BY task_id, path"):
                    links_by_task.setdefault(row["task_id"], []).append(row["path"])
                for task in tasks:
                    task["links"] = links_by_task.get(task["id"], [])
            sync_row = conn.execute("SELECT * FROM file_sync_state WHERE singleton=1").fetchone()
            file_count = conn.execute("SELECT COUNT(*) FROM file_records").fetchone()[0]
            file_sync = dict(sync_row) if sync_row else {
                "source_ref": "",
                "source_commit": "",
                "synced_at": "",
                "file_count": int(file_count),
                "editor": "",
            }
            file_sync["file_count"] = int(file_count)
            return {
                "goals": goals,
                "tasks": tasks,
                "revision": meta["revision"],
                "order_revision": meta["order_revision"],
                "cutover": meta["cutover"],
                "cutover_time": meta["cutover_time"],
                "updated": meta["updated"],
                "file_sync": file_sync,
                "db_backend": self.backend_info(),
            }

    def mail_index(self, *, include_tags: bool) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            meta = conn.execute("SELECT revision FROM metadata WHERE singleton=1").fetchone()
            if not meta:
                raise TodoError("Goal tracking has not been seeded", 503)
            tasks = [
                dict(row)
                for row in conn.execute(
                    """SELECT tasks.id, tasks.title, tasks.state, tasks.decision
                       FROM tasks JOIN goals ON goals.id=tasks.goal_id
                       WHERE tasks.removed=0 AND goals.removed=0 ORDER BY goals.number, tasks.position"""
                )
            ]
            tags = dict(conn.execute("SELECT event_id,task_id FROM tags")) if include_tags else {}
            return {"revision": meta["revision"], "tasks": tasks, "tags": tags}

    def activity(self, task_id: str | None = None) -> tuple[dict[str, str], list[str]]:
        with closing(self.connect()) as conn:
            tags = dict(conn.execute("SELECT event_id,task_id FROM tags"))
            links = [row[0] for row in conn.execute("SELECT path FROM links WHERE task_id=? ORDER BY path", (task_id,))]
        return tags, links

    def linked_paths(self) -> set[str]:
        with closing(self.connect()) as conn:
            return {
                row[0]
                for row in conn.execute(
                    """SELECT DISTINCT links.path FROM links JOIN tasks ON tasks.id=links.task_id
                       JOIN goals ON goals.id=tasks.goal_id WHERE tasks.removed=0 AND goals.removed=0"""
                )
            }

    def task_membership(self) -> tuple[set[str], set[str], dict[str, str]] | None:
        if not self.initialized():
            return None
        try:
            with closing(self.connect()) as conn:
                has_tasks = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'"
                ).fetchone()
                if not has_tasks:
                    return None
                rows = conn.execute(
                    "SELECT tasks.id, tasks.removed, goals.removed FROM tasks JOIN goals ON goals.id = tasks.goal_id"
                ).fetchall()
                tags = dict(conn.execute("SELECT event_id, task_id FROM tags"))
        except Exception:
            return None
        active = {row[0] for row in rows if not row[1] and not row[2]}
        retired = {row[0] for row in rows if row[0] not in active}
        return active, retired, tags

    @staticmethod
    def _record(conn: sqlite3.Connection, table: str, key: Any) -> dict[str, Any]:
        row = conn.execute(f"SELECT * FROM {table} WHERE id=? AND removed=0", (key,)).fetchone()
        if not row or (
            table == "tasks"
            and not conn.execute("SELECT 1 FROM goals WHERE id=? AND removed=0", (row["goal_id"],)).fetchone()
        ):
            raise TodoError(f"{key} is not active", 404)
        return dict(row)

    @staticmethod
    def _expected(values: dict[str, Any], field: str, actual: Any, current: Any) -> None:
        wanted = values.get(field)
        if type(wanted) is not int:
            raise TodoError(f"{field} is required")
        if wanted != actual:
            raise TodoError("This item changed. Reload its current revision before saving.", 409, current)

    @staticmethod
    def _update_task(
        conn: sqlite3.Connection,
        key: Any,
        fields: dict[str, Any],
        editor: str,
        *,
        stamp: str | None = None,
    ) -> None:
        updated_fields = {**fields, "updated": stamp or now(), "editor": editor}
        setters = ",".join(f"{field}=?" for field in updated_fields)
        conn.execute(f"UPDATE tasks SET {setters},revision=revision+1 WHERE id=?", (*updated_fields.values(), key))

    def mutate(self, values: dict[str, Any], editor: str, owners: set[str]) -> dict[str, Any]:
        admin = editor == "user"
        action = values.get("action")
        if not isinstance(action, str):
            raise TodoError("action is required")
        if not admin and action not in {"add", "update", "link"}:
            raise TodoError("This operation requires USER", 403)
        key = values.get("id")
        if key is not None and not isinstance(key, str):
            raise TodoError("id must be text")
        result: Any = {}
        changes_order = False
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            meta = conn.execute("SELECT order_revision FROM metadata WHERE singleton=1").fetchone()
            if not meta:
                raise TodoError("Goal tracking has not been seeded", 503)
            if action == "goal-add":
                title = task_title(values)
                number = conn.execute("SELECT COALESCE(MAX(number),0)+1 FROM goals").fetchone()[0]
                key = f"G{number}"
                conn.execute("INSERT INTO goals(id,number,title) VALUES (?,?,?)", (key, number, title))
                result = self._record(conn, "goals", key)
                changes_order = True
            elif action in {"goal-update", "goal-remove"}:
                row = self._record(conn, "goals", key)
                self._expected(values, "revision", row["revision"], row)
                if action == "goal-remove":
                    count = conn.execute("SELECT COUNT(*) FROM tasks WHERE goal_id=? AND removed=0", (key,)).fetchone()[0]
                    if count and (values.get("confirm_count") != count or type(values.get("confirm_count")) is not int):
                        raise TodoError(
                            f"Confirm removal of the goal and its {count} active sub-goals",
                            409,
                            {"count": count, "revision": row["revision"]},
                        )
                    conn.execute("UPDATE goals SET removed=1,revision=revision+1 WHERE id=?", (key,))
                    result = {"id": key, "removed": True}
                    changes_order = True
                else:
                    conn.execute("UPDATE goals SET title=?,revision=revision+1 WHERE id=?", (task_title(values), key))
                    result = self._record(conn, "goals", key)
            elif action == "add":
                goal = values.get("goal_id")
                if not isinstance(goal, str):
                    raise TodoError("Choose a goal")
                self._record(conn, "goals", goal)
                number, position = conn.execute(
                    "SELECT COALESCE(MAX(number),0)+1, COALESCE(MAX(position),0)+1 FROM tasks WHERE goal_id=?",
                    (goal,),
                ).fetchone()
                key = f"{goal}.{number}"
                fields = validate_task_fields(values, owners, admin, creating=True)
                fields["title"] = task_title(values)
                stamp = now()
                done_at = stamp if fields.get("state") == "done" else ""
                columns = ",".join(fields)
                placeholders = ",".join("?" for _ in fields)
                conn.execute(
                    f"""INSERT INTO tasks(id,goal_id,number,position,updated,done_at,editor,{columns})
                        VALUES (?,?,?,?,?,?,?,{placeholders})""",
                    (key, goal, number, position, stamp, done_at, editor, *fields.values()),
                )
                result = self._record(conn, "tasks", key)
                changes_order = True
            elif action == "tag":
                event_id = values.get("event_id")
                if not isinstance(event_id, str) or not re.fullmatch(r"e[0-9]+", event_id):
                    raise TodoError("Invalid message ID")
                if key is not None:
                    self._record(conn, "tasks", key)
                conn.execute(
                    "INSERT INTO tags VALUES (?,?) ON CONFLICT(event_id) DO UPDATE SET task_id=excluded.task_id",
                    (event_id, key),
                )
                result = {"event_id": event_id, "task_id": key}
            elif action in {"update", "remove", "move", "link", "unlink"}:
                row = self._record(conn, "tasks", key)
                if action == "move":
                    self._expected(
                        values,
                        "order_revision",
                        meta["order_revision"],
                        {"order_revision": meta["order_revision"]},
                    )
                    order = [
                        item[0]
                        for item in conn.execute(
                            "SELECT id FROM tasks WHERE goal_id=? AND removed=0 ORDER BY position",
                            (row["goal_id"],),
                        )
                    ]
                    old = order.index(key)
                    direction = values.get("direction")
                    if direction not in ("up", "down", "top"):
                        raise TodoError("Choose up, down or top")
                    new = {"up": max(old - 1, 0), "down": min(old + 1, len(order) - 1), "top": 0}[direction]
                    order.insert(new, order.pop(old))
                    conn.executemany("UPDATE tasks SET position=? WHERE id=?", enumerate(order, 1))
                    result = self._record(conn, "tasks", key)
                    changes_order = True
                elif action in {"link", "unlink"}:
                    path = relative_file(values.get("path"))
                    if action == "link":
                        conn.execute("INSERT OR IGNORE INTO links VALUES (?,?,?)", (key, path, editor))
                    else:
                        conn.execute("DELETE FROM links WHERE task_id=? AND path=?", (key, path))
                    result = {"id": key, "path": path}
                else:
                    self._expected(values, "revision", row["revision"], row)
                    fields = {"removed": 1} if action == "remove" else validate_task_fields(values, owners, admin)
                    if (
                        action == "update"
                        and row["decision"]
                        and fields.get("decision", 1)
                        and fields.get("state", "blocked") != "blocked"
                    ):
                        if not admin:
                            raise TodoError("Only USER can resolve this decision", 403)
                        raise TodoError("Clear the USER decision flag to change this state")
                    stamp = now()
                    if action == "update":
                        prev_state = row["state"]
                        next_state = fields.get("state", prev_state)
                        if next_state == "done" and (prev_state != "done" or not row.get("done_at")):
                            fields["done_at"] = stamp
                        elif next_state != "done" and prev_state == "done":
                            fields["done_at"] = ""
                    self._update_task(conn, key, fields, editor, stamp=stamp)
                    result = {"id": key, "removed": True} if action == "remove" else self._record(conn, "tasks", key)
                    changes_order = action == "remove"
            else:
                raise TodoError("Unknown goal-tracking action")
            conn.execute(
                "UPDATE metadata SET revision=revision+1,order_revision=order_revision+?,updated=?",
                (int(changes_order), now()),
            )
        return {"item": result}

    def _existing_records_map(self) -> dict[str, dict[str, Any]]:
        if not self.initialized():
            return {}
        with closing(self.connect()) as conn:
            has_fr = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_records'").fetchone()
            if not has_fr:
                return {}
            return {
                row["path"]: dict(row)
                for row in conn.execute("SELECT * FROM file_records")
            }

    def upsert_files(
        self,
        items: list[dict[str, Any]],
        *,
        prune_prefixes: tuple[str, ...] = (),
        keep_paths: Iterable[str] | None = None,
        update_sync_state: bool = True,
        source_ref: str = "",
        source_commit: str = "",
        editor: str = "",
        content_loader: Callable[[str, str], bytes] | None = None,
    ) -> dict[str, Any]:
        if not self.initialized():
            raise TodoError("Goal tracking has not been seeded", 503)

        existing = self._existing_records_map()
        prepared: list[dict[str, Any]] = []
        seen_paths: set[str] = set()
        blobs_written = 0
        updated_paths = 0
        unchanged_paths = 0
        keep_set = seen_paths if keep_paths is None else {relative_file(p) for p in keep_paths}

        for item in items:
            path = relative_file(item.get("path"))
            if path.startswith(ATTACH_REF_PREFIX):
                raise TodoError("Use attachment storage for coordination/attachments/", 400)
            if path in seen_paths:
                continue
            seen_paths.add(path)
            s_ref = str(item.get("source_ref") if item.get("source_ref") is not None else source_ref)
            s_commit = str(item.get("source_commit") if item.get("source_commit") is not None else source_commit)
            s_blob = str(item.get("source_blob") or "")
            raw = item.get("content")
            exp_sha = str(item.get("sha256") or "").strip().lower()
            exp_size = item.get("size")
            prev = existing.get(path)

            if raw is not None:
                if not isinstance(raw, (bytes, bytearray)):
                    raise TodoError(f"Invalid bytes payload for {path}")
                raw_bytes = bytes(raw)
                if len(raw_bytes) > MAX_SYNC_FILE_BYTES:
                    raise TodoError(f"File exceeds {MAX_SYNC_FILE_BYTES} bytes: {path}")
                sha = hashlib.sha256(raw_bytes).hexdigest()
                if exp_sha and sha != exp_sha:
                    raise BlobIntegrityError(f"SHA-256 mismatch for {path}")
                size = len(raw_bytes)
                if exp_size is not None and int(exp_size) != size:
                    raise BlobIntegrityError(f"Size mismatch for {path}")
                if not self.has_blob(sha):
                    self.store_verified_blob(sha, raw_bytes)
                    blobs_written += 1
            elif (
                prev
                and s_blob
                and prev.get("source_blob") == s_blob
                and SHA256_RE.fullmatch(str(prev.get("sha256") or ""))
                and self.has_blob(prev["sha256"])
            ):
                sha = prev["sha256"]
                size = int(prev["size"])
            else:
                if content_loader is None:
                    if not exp_sha or exp_size is None or not self.has_blob(exp_sha):
                        raise TodoError(f"Missing content payload or loader for {path}")
                    sha = validate_sha256(exp_sha)
                    size = int(exp_size)
                else:
                    raw_bytes = content_loader(path, s_blob)
                    if len(raw_bytes) > MAX_SYNC_FILE_BYTES:
                        raise TodoError(f"File exceeds {MAX_SYNC_FILE_BYTES} bytes: {path}")
                    sha = hashlib.sha256(raw_bytes).hexdigest()
                    if exp_sha and sha != exp_sha:
                        raise BlobIntegrityError(f"SHA-256 mismatch for {path}")
                    size = len(raw_bytes)
                    if exp_size is not None and int(exp_size) != size:
                        raise BlobIntegrityError(f"Size mismatch for {path}")
                    if not self.has_blob(sha):
                        self.store_verified_blob(sha, raw_bytes)
                        blobs_written += 1

            prepared.append(
                {
                    "path": path,
                    "sha256": sha,
                    "size": size,
                    "source_ref": s_ref,
                    "source_commit": s_commit,
                    "source_blob": s_blob,
                    "editor": str(item.get("editor") or editor),
                }
            )

        stamp = now()
        pruned = 0
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute("SELECT 1 FROM metadata WHERE singleton=1").fetchone():
                raise TodoError("Goal tracking has not been seeded", 503)
            for rec in prepared:
                prev = existing.get(rec["path"])
                if (
                    prev
                    and prev["sha256"] == rec["sha256"]
                    and int(prev["size"]) == rec["size"]
                    and prev["source_ref"] == rec["source_ref"]
                    and prev["source_commit"] == rec["source_commit"]
                    and prev["source_blob"] == rec["source_blob"]
                ):
                    unchanged_paths += 1
                    continue
                updated_paths += 1
                conn.execute(
                    """INSERT INTO file_records(path,sha256,size,source_ref,source_commit,source_blob,synced_at,editor)
                       VALUES (?,?,?,?,?,?,?,?)
                       ON CONFLICT(path) DO UPDATE SET
                           sha256=excluded.sha256,
                           size=excluded.size,
                           source_ref=excluded.source_ref,
                           source_commit=excluded.source_commit,
                           source_blob=excluded.source_blob,
                           synced_at=excluded.synced_at,
                           editor=excluded.editor""",
                    (
                        rec["path"],
                        rec["sha256"],
                        rec["size"],
                        rec["source_ref"],
                        rec["source_commit"],
                        rec["source_blob"],
                        stamp,
                        rec["editor"],
                    ),
                )
            for pref in prune_prefixes:
                norm_pref = pref.lstrip("./")
                if norm_pref and not norm_pref.endswith("/"):
                    norm_pref += "/"
                rows = conn.execute(
                    "SELECT path, source_ref FROM file_records WHERE substr(path, 1, ?) = ?",
                    (len(norm_pref), norm_pref),
                ).fetchall()
                for row in rows:
                    if row["path"] not in keep_set and row["source_ref"] != "local-file":
                        conn.execute("DELETE FROM file_records WHERE path=?", (row["path"],))
                        pruned += 1
            total_count = int(conn.execute("SELECT COUNT(*) FROM file_records").fetchone()[0])
            if update_sync_state and (prune_prefixes or source_commit or source_ref):
                conn.execute(
                    """INSERT INTO file_sync_state(singleton,source_ref,source_commit,synced_at,file_count,editor)
                       VALUES (1,?,?,?,?,?)
                       ON CONFLICT(singleton) DO UPDATE SET
                           source_ref=excluded.source_ref,
                           source_commit=excluded.source_commit,
                           synced_at=excluded.synced_at,
                           file_count=excluded.file_count,
                           editor=excluded.editor""",
                    (source_ref, source_commit, stamp, total_count, editor),
                )

        return {
            "source_ref": source_ref,
            "source_commit": source_commit,
            "synced_at": stamp,
            "total_records": total_count,
            "updated": updated_paths,
            "unchanged": unchanged_paths,
            "pruned": pruned,
            "blobs_written": blobs_written,
            "db_backend": self.backend_info(),
        }

    def get_file_record(self, path: str) -> dict[str, Any] | None:
        if not self.initialized():
            return None
        try:
            clean = relative_file(path)
        except TodoError:
            return None
        with closing(self.connect()) as conn:
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_records'").fetchone():
                return None
            row = conn.execute("SELECT * FROM file_records WHERE path=?", (clean,)).fetchone()
            return dict(row) if row else None

    def read_file_content(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        rec = self.get_file_record(path)
        if rec is None:
            return None
        sha = validate_sha256(rec.get("sha256"))
        bp = self.blob_path(sha)
        if not bp.is_file():
            raise FileNotFoundError(f"Missing blob for {rec['path']} ({sha})")
        raw = bp.read_bytes()
        if len(raw) != int(rec["size"]) or hashlib.sha256(raw).hexdigest() != sha:
            raise BlobIntegrityError(f"Corrupt blob for {rec['path']} ({sha})")
        return rec, raw

    def list_file_records(self, prefix: str = "") -> list[dict[str, Any]]:
        if not self.initialized():
            return []
        clean = (prefix or "").strip().lstrip("./").replace("\\", "/")
        with closing(self.connect()) as conn:
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_records'").fetchone():
                return []
            if clean:
                rows = conn.execute(
                    "SELECT * FROM file_records WHERE substr(path, 1, ?) = ? ORDER BY path",
                    (len(clean), clean),
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM file_records ORDER BY path").fetchall()
            return [dict(r) for r in rows]

    def file_sync_status(self) -> dict[str, Any]:
        if not self.initialized():
            return {"initialized": False, "file_count": 0, "source_ref": "", "source_commit": "", "synced_at": ""}
        with closing(self.connect()) as conn:
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_sync_state'").fetchone():
                return {"initialized": True, "file_count": 0, "source_ref": "", "source_commit": "", "synced_at": ""}
            row = conn.execute("SELECT * FROM file_sync_state WHERE singleton=1").fetchone()
            cnt = int(conn.execute("SELECT COUNT(*) FROM file_records").fetchone()[0])
            out = dict(row) if row else {"source_ref": "", "source_commit": "", "synced_at": "", "editor": ""}
            out["initialized"] = True
            out["file_count"] = cnt
            out["db_backend"] = self.backend_info()
            return out


class HttpDatabase(MailroomDatabase):
    """Stdlib client adapter for a pluggable user-hosted Mailroom HTTP database service."""

    def __init__(self, base_url: str, *, token: str | None = None, timeout: float = 30.0):
        clean = base_url.strip().rstrip("/")
        parsed = urlparse(clean)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise TodoError(f"Invalid HTTP database URL: {base_url!r}")
        self.base_url = clean
        self.token = (token or "").strip()
        self.timeout = float(timeout)

    def backend_info(self) -> dict[str, Any]:
        parsed = urlparse(self.base_url)
        return {"kind": "http", "scheme": parsed.scheme, "endpoint": parsed.netloc}

    def _call(self, method: str, endpoint: str, payload: Any = None) -> Any:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        req = Request(self.base_url + endpoint, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except HTTPError as exc:
            msg = exc.reason or f"HTTP {exc.code}"
            current = None
            try:
                err_body = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
                if isinstance(err_body, dict):
                    msg = str(err_body.get("error") or msg)
                    current = err_body.get("current")
            except Exception:
                pass
            if exc.code >= 500 and "mismatch" in msg.lower():
                raise BlobIntegrityError(msg, status=exc.code, current=current) from exc
            raise TodoError(msg, status=exc.code, current=current) from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise TodoError(f"User-hosted database error: {exc}", status=503) from exc

    def initialized(self) -> bool:
        try:
            res = self._call("GET", "/health")
            return bool(res.get("initialized"))
        except TodoError:
            return False

    def seed(
        self,
        goals: dict[str, tuple[int, str]],
        tasks: list[tuple[str, str, int, str, str]],
        cutover: int,
        *,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        if dry_run:
            return {"goals": list(goals), "tasks": [row[0] for row in tasks]}
        return self._call(
            "POST",
            "/seed",
            {"goals": goals, "tasks": tasks, "cutover": cutover},
        )

    def list_state(self, *, include_links: bool = False) -> dict[str, Any]:
        qs = urlencode({"include_links": "1" if include_links else "0"})
        out = self._call("GET", f"/state?{qs}")
        out.setdefault("db_backend", self.backend_info())
        return out

    def mail_index(self, *, include_tags: bool) -> dict[str, Any]:
        qs = urlencode({"include_tags": "1" if include_tags else "0"})
        return self._call("GET", f"/mail-index?{qs}")

    def activity(self, task_id: str | None = None) -> tuple[dict[str, str], list[str]]:
        qs = urlencode({"task_id": task_id or ""})
        res = self._call("GET", f"/activity?{qs}")
        return dict(res.get("tags") or {}), list(res.get("links") or [])

    def linked_paths(self) -> set[str]:
        res = self._call("GET", "/linked-paths")
        return set(res.get("paths") or [])

    def task_membership(self) -> tuple[set[str], set[str], dict[str, str]] | None:
        try:
            res = self._call("GET", "/membership")
        except TodoError:
            return None
        if not res or not res.get("initialized", True):
            return None
        return set(res.get("active") or []), set(res.get("retired") or []), dict(res.get("tags") or {})

    def mutate(self, values: dict[str, Any], editor: str, owners: set[str]) -> dict[str, Any]:
        return self._call(
            "POST",
            "/mutate",
            {"values": values, "editor": editor, "owners": sorted(owners)},
        )

    def has_blob(self, sha256: str) -> bool:
        digest = validate_sha256(sha256)
        res = self._call("GET", "/files/has-blob?" + urlencode({"sha256": digest}))
        return bool(res.get("present"))

    def store_verified_blob(self, sha256: str, content: bytes) -> None:
        digest = validate_sha256(sha256)
        actual = hashlib.sha256(content).hexdigest()
        if actual != digest:
            raise BlobIntegrityError(f"Blob digest mismatch: expected {digest}, got {actual}")
        self._call(
            "POST",
            "/files/blob",
            {"sha256": digest, "content_b64": base64.b64encode(content).decode("ascii")},
        )

    def upsert_files(
        self,
        items: list[dict[str, Any]],
        *,
        prune_prefixes: tuple[str, ...] = (),
        keep_paths: Iterable[str] | None = None,
        update_sync_state: bool = True,
        source_ref: str = "",
        source_commit: str = "",
        editor: str = "",
        content_loader: Callable[[str, str], bytes] | None = None,
    ) -> dict[str, Any]:
        existing = {r["path"]: r for r in self.list_file_records()}
        explicit_keep = [relative_file(p) for p in keep_paths] if keep_paths is not None else None
        payload_items: list[dict[str, Any]] = []
        for item in items:
            path = relative_file(item.get("path"))
            if path.startswith(ATTACH_REF_PREFIX):
                raise TodoError("Use attachment storage for coordination/attachments/", 400)
            s_blob = str(item.get("source_blob") or "")
            s_ref = str(item.get("source_ref") if item.get("source_ref") is not None else source_ref)
            s_commit = str(item.get("source_commit") if item.get("source_commit") is not None else source_commit)
            raw = item.get("content")
            exp_sha = str(item.get("sha256") or "").strip().lower()
            exp_size = item.get("size")
            prev = existing.get(path)
            content_b64: str | None = None
            if raw is not None:
                raw_bytes = bytes(raw)
                sha = hashlib.sha256(raw_bytes).hexdigest()
                if exp_sha and sha != exp_sha:
                    raise BlobIntegrityError(f"SHA-256 mismatch for {path}")
                size = len(raw_bytes)
                content_b64 = base64.b64encode(raw_bytes).decode("ascii")
            elif prev and s_blob and prev.get("source_blob") == s_blob and prev.get("sha256"):
                sha = str(prev["sha256"])
                size = int(prev["size"])
            else:
                if content_loader is None:
                    raise TodoError(f"Missing content payload or loader for {path}")
                raw_bytes = content_loader(path, s_blob)
                sha = hashlib.sha256(raw_bytes).hexdigest()
                if exp_sha and sha != exp_sha:
                    raise BlobIntegrityError(f"SHA-256 mismatch for {path}")
                size = len(raw_bytes)
                content_b64 = base64.b64encode(raw_bytes).decode("ascii")
            entry: dict[str, Any] = {
                "path": path,
                "sha256": sha,
                "size": size,
                "source_ref": s_ref,
                "source_commit": s_commit,
                "source_blob": s_blob,
                "editor": str(item.get("editor") or editor),
            }
            if content_b64 is not None:
                entry["content_b64"] = content_b64
            payload_items.append(entry)

        # Send in bounded batches so user-hosted HTTP services never see oversized requests.
        last_res: dict[str, Any] = {}
        batch: list[dict[str, Any]] = []
        batch_bytes = 0
        max_batch_bytes = 2 * 1024 * 1024
        total_updated = 0
        total_unchanged = 0
        total_pruned = 0
        total_blobs_written = 0
        for idx, entry in enumerate(payload_items):
            sz = len(entry.get("content_b64") or "") + len(entry["path"]) + 256
            if batch and (len(batch) >= 25 or batch_bytes + sz > max_batch_bytes):
                batch_res = self._call(
                    "POST",
                    "/files/upsert",
                    {
                        "items": batch,
                        "prune_prefixes": [],
                        "update_sync_state": False,
                        "source_ref": source_ref,
                        "source_commit": source_commit,
                        "editor": editor,
                        "finalize": False,
                    },
                )
                total_updated += int(batch_res.get("updated") or 0)
                total_unchanged += int(batch_res.get("unchanged") or 0)
                total_pruned += int(batch_res.get("pruned") or 0)
                total_blobs_written += int(batch_res.get("blobs_written") or 0)
                batch = []
                batch_bytes = 0
            batch.append(entry)
            batch_bytes += sz
        all_paths = explicit_keep if explicit_keep is not None else ([e["path"] for e in payload_items] if prune_prefixes else None)
        last_res = self._call(
            "POST",
            "/files/upsert",
            {
                "items": batch,
                "prune_prefixes": list(prune_prefixes),
                "update_sync_state": bool(update_sync_state),
                "source_ref": source_ref,
                "source_commit": source_commit,
                "editor": editor,
                "finalize": True,
                "all_paths": all_paths,
            },
        )
        last_res["updated"] = total_updated + int(last_res.get("updated") or 0)
        last_res["unchanged"] = total_unchanged + int(last_res.get("unchanged") or 0)
        last_res["pruned"] = total_pruned + int(last_res.get("pruned") or 0)
        last_res["blobs_written"] = total_blobs_written + int(last_res.get("blobs_written") or 0)
        return last_res

    def get_file_record(self, path: str) -> dict[str, Any] | None:
        try:
            clean = relative_file(path)
        except TodoError:
            return None
        try:
            res = self._call("GET", "/files/record?" + urlencode({"path": clean}))
            rec = res.get("record")
            return dict(rec) if rec else None
        except TodoError as exc:
            if exc.status == 404:
                return None
            raise

    def read_file_content(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        try:
            clean = relative_file(path)
        except TodoError:
            return None
        try:
            res = self._call("GET", "/files/content?" + urlencode({"path": clean}))
        except TodoError as exc:
            if exc.status == 404:
                return None
            raise
        rec = res.get("record")
        if not rec:
            return None
        sha = validate_sha256(rec.get("sha256"))
        raw = base64.b64decode(str(res.get("content_b64") or ""))
        if len(raw) != int(rec["size"]) or hashlib.sha256(raw).hexdigest() != sha:
            raise BlobIntegrityError(f"Corrupt HTTP DB payload for {clean} ({sha})")
        return dict(rec), raw

    def list_file_records(self, prefix: str = "") -> list[dict[str, Any]]:
        clean = (prefix or "").strip().lstrip("./").replace("\\", "/")
        try:
            res = self._call("GET", "/files/list?" + urlencode({"prefix": clean}))
        except TodoError as exc:
            if exc.status == 503:
                return []
            raise
        return [dict(r) for r in (res.get("records") or [])]

    def file_sync_status(self) -> dict[str, Any]:
        try:
            res = self._call("GET", "/files/sync-status")
            res.setdefault("db_backend", self.backend_info())
            return res
        except TodoError:
            return {"initialized": False, "file_count": 0, "source_ref": "", "source_commit": "", "synced_at": ""}


_BACKEND_FACTORIES: dict[str, Callable[..., MailroomDatabase]] = {}


def register_backend(scheme: str, factory: Callable[..., MailroomDatabase]) -> None:
    """Register a custom Mailroom database backend factory for URL `scheme://...`."""
    key = scheme.strip().lower()
    if not key or not re.fullmatch(r"[a-z][a-z0-9+.-]*", key):
        raise ValueError(f"Invalid backend scheme: {scheme!r}")
    _BACKEND_FACTORIES[key] = factory


def _load_backend_class(spec: str) -> Callable[..., MailroomDatabase]:
    mod_name, sep, attr = spec.partition(":")
    if not sep or not mod_name or not attr:
        raise ValueError(f"MAILROOM_DB_BACKEND must be 'module:ClassName', got {spec!r}")
    mod = importlib.import_module(mod_name)
    cls = getattr(mod, attr)
    return cls


def open_database(
    url_or_path: Path | str,
    *,
    blob_dir: Path | str | None = None,
    token: str | None = None,
    backend_spec: str | None = None,
) -> MailroomDatabase:
    """Instantiate the configured `MailroomDatabase` backend."""
    spec = (backend_spec if backend_spec is not None else os.environ.get("MAILROOM_DB_BACKEND", "")).strip()
    effective_token = token if token is not None else os.environ.get("MAILROOM_DB_TOKEN", "").strip()
    if spec:
        factory = _load_backend_class(spec)
        return factory(url_or_path, blob_dir=blob_dir, token=effective_token)

    if isinstance(url_or_path, Path):
        return SqliteDatabase(url_or_path, blob_dir=blob_dir)

    raw = str(url_or_path).strip()
    if not raw:
        raise TodoError("Empty database target")
    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme in {"http", "https"}:
        return HttpDatabase(raw, token=effective_token or None)
    if scheme == "sqlite":
        if parsed.netloc and parsed.netloc not in {"", "localhost"}:
            raise TodoError(f"Unsupported remote sqlite netloc: {parsed.netloc!r}")
        fs_path = parsed.path or ""
        if not fs_path:
            raise TodoError("Missing sqlite path in URI")
        return SqliteDatabase(Path(fs_path), blob_dir=blob_dir)
    if scheme and scheme in _BACKEND_FACTORIES:
        return _BACKEND_FACTORIES[scheme](raw, blob_dir=blob_dir, token=effective_token)
    if scheme and len(scheme) > 1:
        raise TodoError(f"Unsupported database URL scheme: {scheme!r}")
    return SqliteDatabase(Path(raw), blob_dir=blob_dir)
