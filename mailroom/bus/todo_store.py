"""Goal tracking state, independent of the append-only message log."""
from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import tempfile

GOAL = re.compile(r"G([1-9][0-9]{0,8})")
TASK = re.compile(r"(G[1-9][0-9]{0,8})\.([1-9][0-9]{0,8})")
STATES = ("todo", "doing", "blocked", "done")
PRIORITIES = ("high", "normal", "low")
TITLES = re.compile(r"^## (?:Goal (\d+)\. (.+)|Cross-cutting: (.+) \(proposed Goal (\d+)\))$")
SEED_TASK = re.compile(r"^- (G\d+)\.(\d+) `\[([x~? ])\]` (.+)$")
HOST_PATH = re.compile(r"(?<![\w/])(?:/(?:home|mnt|tmp|Users|root|run/user)/|[A-Za-z]:\\Users\\)[^\s<>\"'`]+")
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
    revision INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL, editor TEXT NOT NULL,
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
"""


class TodoError(ValueError):
    def __init__(self, message: str, status: int = 400, current=None):
        super().__init__(message)
        self.status = status
        self.current = current


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def seed_rows(roadmap: Path) -> tuple[dict, list]:
    goals, tasks = {}, []
    for line in roadmap.read_text(encoding="utf-8").splitlines():
        header = TITLES.fullmatch(line)
        if header:
            number, title, cross, cross_number = header.groups()
            number = int(number or cross_number)
            key = f"G{number}"
            if key in goals:
                raise TodoError(f"Duplicate roadmap goal {key}")
            goals[key] = (number, title or cross)
        row = SEED_TASK.fullmatch(line)
        if row:
            goal, number, mark, title = row.groups()
            tasks.append((f"{goal}.{number}", goal, int(number), title, mark))
    if not goals or not tasks or any(goal not in goals for _, goal, *_ in tasks):
        raise TodoError("The roadmap has missing goals or tasks")
    if len({key for key, *_ in tasks}) != len(tasks):
        raise TodoError("The roadmap contains duplicate task IDs")
    return goals, tasks


def text_field(value, label, maximum):
    if not isinstance(value, str) or len(value) > maximum or "\x00" in value:
        raise TodoError(f"{label} must be text of up to {maximum} characters")
    return value.strip()


def relative_file(value) -> str:
    raw = text_field(value, "File path", 500)
    path = PurePosixPath(raw)
    if (not raw or path.is_absolute() or ":" in raw or "\\" in raw or any(c in raw for c in "\r\n")
            or any(part.startswith(".") for part in path.parts) or not path.suffix):
        raise TodoError("Use a repository-relative file path")
    return path.as_posix()


class TodoStore:
    def __init__(self, db: Path, roadmap: Path, output: Path):
        self.db, self.roadmap, self.output = db, roadmap, output

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def initialized(self) -> bool:
        return self.db.is_file()

    def seed(self, cutover: int, *, dry_run=False):
        goals, tasks = seed_rows(self.roadmap)
        if dry_run:
            return {"goals": list(goals), "tasks": [row[0] for row in tasks]}
        with closing(self.connect()) as conn:
            conn.executescript(SCHEMA)
            with conn:
                stamp = now()
                cursor = conn.execute("INSERT OR IGNORE INTO metadata VALUES (1,1,1,?,?,?)", (cutover, stamp, stamp))
                created = cursor.rowcount > 0
                if created:
                    conn.executemany("INSERT INTO goals(id,number,title) VALUES (?,?,?)",
                                     ((key, *values) for key, values in goals.items()))
                    conn.executemany(
                        """INSERT INTO tasks(id,goal_id,number,position,title,state,decision,updated,editor)
                           VALUES (?,?,?,?,?,?,?,?, 'seed')""",
                        ((key, goal, number, number, title, {" ": "todo", "~": "doing", "?": "blocked", "x": "done"}[mark],
                          int(mark == "?"), stamp) for key, goal, number, title, mark in tasks),
                    )
        return {"seeded": created, **self.try_export()}

    def listing(self, *, include_links: bool = False):
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            meta = conn.execute("SELECT * FROM metadata WHERE singleton=1").fetchone()
            if not meta:
                raise TodoError("Goal tracking has not been seeded", 503)
            goals = [dict(row) for row in conn.execute("SELECT * FROM goals WHERE removed=0 ORDER BY number")]
            tasks = [dict(row) for row in conn.execute(
                """SELECT tasks.* FROM tasks JOIN goals ON goals.id=tasks.goal_id
                   WHERE tasks.removed=0 AND goals.removed=0 ORDER BY goals.number, tasks.position""")]
            if include_links:
                links_by_task: dict[str, list[str]] = {}
                for row in conn.execute("SELECT task_id, path FROM links ORDER BY task_id, path"):
                    links_by_task.setdefault(row["task_id"], []).append(row["path"])
                for task in tasks:
                    task["links"] = links_by_task.get(task["id"], [])
            return {"goals": goals, "tasks": tasks, "revision": meta["revision"],
                    "order_revision": meta["order_revision"], "cutover": meta["cutover"],
                    "cutover_time": meta["cutover_time"], "updated": meta["updated"]}

    def mail_index(self, *, include_tags: bool):
        with closing(self.connect()) as conn:
            conn.execute("BEGIN")
            meta = conn.execute("SELECT revision FROM metadata WHERE singleton=1").fetchone()
            if not meta:
                raise TodoError("Goal tracking has not been seeded", 503)
            tasks = [dict(row) for row in conn.execute(
                """SELECT tasks.id, tasks.title, tasks.state, tasks.decision
                   FROM tasks JOIN goals ON goals.id=tasks.goal_id
                   WHERE tasks.removed=0 AND goals.removed=0 ORDER BY goals.number, tasks.position""")]
            tags = dict(conn.execute("SELECT event_id,task_id FROM tags")) if include_tags else {}
            return {"revision": meta["revision"], "tasks": tasks, "tags": tags}

    def activity(self, task_id: str | None = None):
        with closing(self.connect()) as conn:
            tags = dict(conn.execute("SELECT event_id,task_id FROM tags"))
            links = [row[0] for row in conn.execute("SELECT path FROM links WHERE task_id=? ORDER BY path", (task_id,))]
        return tags, links

    def linked_paths(self):
        with closing(self.connect()) as conn:
            return {row[0] for row in conn.execute(
                """SELECT DISTINCT links.path FROM links JOIN tasks ON tasks.id=links.task_id
                   JOIN goals ON goals.id=tasks.goal_id WHERE tasks.removed=0 AND goals.removed=0""")}

    @staticmethod
    def record(conn, table, key):
        row = conn.execute(f"SELECT * FROM {table} WHERE id=? AND removed=0", (key,)).fetchone()
        if not row or (table == "tasks" and not conn.execute(
                "SELECT 1 FROM goals WHERE id=? AND removed=0", (row["goal_id"],)).fetchone()):
            raise TodoError(f"{key} is not active", 404)
        return dict(row)

    @staticmethod
    def expected(values, field, actual, current):
        wanted = values.get(field)
        if type(wanted) is not int:
            raise TodoError(f"{field} is required")
        if wanted != actual:
            raise TodoError("This item changed. Reload its current revision before saving.", 409, current)

    def mutate(self, values: dict, editor: str, owners: set[str]):
        admin = editor == "user"
        action = values.get("action")
        if not isinstance(action, str):
            raise TodoError("action is required")
        if not admin and action not in {"add", "update", "link"}:
            raise TodoError("This operation requires USER", 403)
        if action == "export":
            return self.try_export()
        key = values.get("id")
        if key is not None and not isinstance(key, str):
            raise TodoError("id must be text")
        result = {}
        changes_order = False
        with closing(self.connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            meta = conn.execute("SELECT order_revision FROM metadata WHERE singleton=1").fetchone()
            if action == "goal-add":
                title = self.title(values)
                number = conn.execute("SELECT COALESCE(MAX(number),0)+1 FROM goals").fetchone()[0]
                key = f"G{number}"
                conn.execute("INSERT INTO goals(id,number,title) VALUES (?,?,?)", (key, number, title))
                result = self.record(conn, "goals", key)
                changes_order = True
            elif action in {"goal-update", "goal-remove"}:
                row = self.record(conn, "goals", key)
                self.expected(values, "revision", row["revision"], row)
                if action == "goal-remove":
                    count = conn.execute("SELECT COUNT(*) FROM tasks WHERE goal_id=? AND removed=0", (key,)).fetchone()[0]
                    if count and (values.get("confirm_count") != count or type(values.get("confirm_count")) is not int):
                        raise TodoError(f"Confirm removal of the goal and its {count} active sub-goals", 409,
                                        {"count": count, "revision": row["revision"]})
                    conn.execute("UPDATE goals SET removed=1,revision=revision+1 WHERE id=?", (key,))
                    result = {"id": key, "removed": True}
                    changes_order = True
                else:
                    conn.execute("UPDATE goals SET title=?,revision=revision+1 WHERE id=?", (self.title(values), key))
                    result = self.record(conn, "goals", key)
            elif action == "add":
                goal = values.get("goal_id")
                if not isinstance(goal, str):
                    raise TodoError("Choose a goal")
                self.record(conn, "goals", goal)
                number, position = conn.execute(
                    "SELECT COALESCE(MAX(number),0)+1, COALESCE(MAX(position),0)+1 FROM tasks WHERE goal_id=?", (goal,)
                ).fetchone()
                key = f"{goal}.{number}"
                fields = self.task_fields(values, owners, admin, creating=True)
                fields["title"] = self.title(values)
                columns = ",".join(fields)
                placeholders = ",".join("?" for _ in fields)
                conn.execute(f"""INSERT INTO tasks(id,goal_id,number,position,updated,editor,{columns})
                              VALUES (?,?,?,?,?,?,{placeholders})""",
                             (key, goal, number, position, now(), editor, *fields.values()))
                result = self.record(conn, "tasks", key)
                changes_order = True
            elif action == "tag":
                event_id = values.get("event_id")
                if not isinstance(event_id, str) or not re.fullmatch(r"e[0-9]+", event_id):
                    raise TodoError("Invalid message ID")
                if key is not None:
                    self.record(conn, "tasks", key)
                conn.execute("INSERT INTO tags VALUES (?,?) ON CONFLICT(event_id) DO UPDATE SET task_id=excluded.task_id",
                             (event_id, key))
                result = {"event_id": event_id, "task_id": key}
            elif action in {"update", "remove", "move", "link", "unlink"}:
                row = self.record(conn, "tasks", key)
                if action == "move":
                    self.expected(values, "order_revision", meta["order_revision"], {"order_revision": meta["order_revision"]})
                    order = [item[0] for item in conn.execute(
                        "SELECT id FROM tasks WHERE goal_id=? AND removed=0 ORDER BY position", (row["goal_id"],))]
                    old = order.index(key)
                    direction = values.get("direction")
                    if direction not in ("up", "down", "top"):
                        raise TodoError("Choose up, down or top")
                    new = {"up": max(old-1, 0), "down": min(old+1, len(order)-1), "top": 0}[direction]
                    order.insert(new, order.pop(old))
                    conn.executemany("UPDATE tasks SET position=? WHERE id=?", enumerate(order, 1))
                    result = self.record(conn, "tasks", key)
                    changes_order = True
                elif action in {"link", "unlink"}:
                    path = relative_file(values.get("path"))
                    if action == "link":
                        conn.execute("INSERT OR IGNORE INTO links VALUES (?,?,?)", (key, path, editor))
                    else:
                        conn.execute("DELETE FROM links WHERE task_id=? AND path=?", (key, path))
                    result = {"id": key, "path": path}
                else:
                    self.expected(values, "revision", row["revision"], row)
                    fields = {"removed": 1} if action == "remove" else self.task_fields(values, owners, admin)
                    if action == "update" and row["decision"] and fields.get("decision", 1) and fields.get("state", "blocked") != "blocked":
                        if not admin:
                            raise TodoError("Only USER can resolve this decision", 403)
                        raise TodoError("Clear the USER decision flag to change this state")
                    self.update_task(conn, key, fields, editor)
                    result = {"id": key, "removed": True} if action == "remove" else self.record(conn, "tasks", key)
                    changes_order = action == "remove"
            else:
                raise TodoError("Unknown goal-tracking action")
            conn.execute("UPDATE metadata SET revision=revision+1,order_revision=order_revision+?,updated=?",
                         (int(changes_order), now()))
        return {"item": result, **self.try_export()}

    @staticmethod
    def title(values):
        title = text_field(values.get("title"), "Title", 800)
        if not title or "\n" in title or "\r" in title:
            raise TodoError("Enter a one-line title")
        return title

    @classmethod
    def task_fields(cls, values, owners, admin, creating=False):
        fields = {}
        admin_keys = {"title", "owner", "priority", "decision", "notes"}
        if not admin and (admin_keys - ({"title", "owner"} if creating else set())).intersection(values):
            raise TodoError("Those fields can only be changed by USER", 403)
        for key, limit in (("owner", 80), ("state", 12), ("priority", 12), ("next_action", 2000),
                           ("blocker", 2000), ("notes", 8000)):
            if key in values:
                fields[key] = text_field(values[key], key, limit)
        if "title" in values:
            fields["title"] = cls.title(values)
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

    @staticmethod
    def update_task(conn, key, fields, editor):
        fields = {**fields, "updated": now(), "editor": editor}
        setters = ",".join(f"{field}=?" for field in fields)
        conn.execute(f"UPDATE tasks SET {setters},revision=revision+1 WHERE id=?", (*fields.values(), key))

    def try_export(self):
        try:
            return {"exported": self.export()}
        except OSError as exc:
            return {"exported": False, "export_warning": f"Task changes are saved. Markdown export failed: {exc.strerror or type(exc).__name__}."}

    def export(self):
        lock = self.db.with_suffix(".export.lock")
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            data = self.listing()
            lines = ["# Goal status", "", "Generated from Mailroom. Edit goals and tasks in Mailroom or through the bus CLI.",
                     "", f"Revision {data['revision']} · {data['updated']}", ""]
            by_goal = {goal["id"]: [] for goal in data["goals"]}
            for task in data["tasks"]:
                by_goal[task["goal_id"]].append(task)
            for goal in data["goals"]:
                lines += [f"## {goal['id']} · {goal['title']}", ""]
                for task in by_goal[goal["id"]]:
                    owner = task["owner"] or "unassigned"
                    decision = " · USER decision" if task["decision"] else ""
                    lines.append(f"- **{task['id']}** · {task['title']} ({task['state']} · {owner} · {task['priority']}{decision})")
                    for field, title in (("next_action", "Next"), ("blocker", "Blocker"), ("notes", "Notes")):
                        if not task[field]:
                            continue
                        lines.append(f"  - {title}")
                        lines.extend(f"    > {line}" for line in task[field].splitlines())
                lines.append("")
            payload = HOST_PATH.sub("[local path]", "\n".join(lines))
            if self.output.is_file() and self.output.read_text(encoding="utf-8") == payload:
                return True
            path = None
            try:
                with tempfile.NamedTemporaryFile(dir=self.output.parent, prefix=".goal-status-", delete=False,
                                                 mode="w", encoding="utf-8") as temp:
                    path = Path(temp.name)
                    temp.write(payload)
                path.chmod(0o644)
                os.replace(path, self.output)
            finally:
                if path is not None:
                    path.unlink(missing_ok=True)
            return True
