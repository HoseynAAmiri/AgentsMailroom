"""Goal tracking and synced repository file state, independent of the append-only message log."""
from __future__ import annotations

from contextlib import closing
import fcntl
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import threading
from typing import Any, Callable, Iterable

_SIBLING_LOCK = threading.RLock()


def _load_db_backend():
    with _SIBLING_LOCK:
        target = Path(__file__).resolve().with_name("db_backend.py")
        runtime_name = "_mailroom_runtime_db_backend"
        for candidate_name in ("db_backend", runtime_name):
            existing = sys.modules.get(candidate_name)
            if existing is not None:
                mfile = getattr(existing, "__file__", None)
                if mfile and Path(mfile).resolve() == target:
                    return existing
        existing = sys.modules.get("db_backend")
        mod_name = runtime_name if existing is not None else "db_backend"
        spec = importlib.util.spec_from_file_location(mod_name, target)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot load db_backend from {target}")
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except BaseException:
            sys.modules.pop(mod_name, None)
            raise
        sys.modules[mod_name] = mod
        return mod


_db_backend = _load_db_backend()
ATTACH_REF_PREFIX = _db_backend.ATTACH_REF_PREFIX
GOAL = _db_backend.GOAL
HOST_PATH = _db_backend.HOST_PATH
PRIORITIES = _db_backend.PRIORITIES
SCHEMA = _db_backend.SCHEMA
SEED_TASK = _db_backend.SEED_TASK
STATES = _db_backend.STATES
TASK = _db_backend.TASK
TITLES = _db_backend.TITLES
BlobIntegrityError = _db_backend.BlobIntegrityError
DatabaseError = _db_backend.DatabaseError
HttpDatabase = _db_backend.HttpDatabase
MailroomDatabase = _db_backend.MailroomDatabase
SqliteDatabase = _db_backend.SqliteDatabase
TodoError = _db_backend.TodoError
now = _db_backend.now
open_database = _db_backend.open_database
register_backend = _db_backend.register_backend
relative_file = _db_backend.relative_file
seed_rows = _db_backend.seed_rows
text_field = _db_backend.text_field
validate_sha256 = _db_backend.validate_sha256

__all__ = [
    "ATTACH_REF_PREFIX",
    "BlobIntegrityError",
    "DatabaseError",
    "GOAL",
    "HOST_PATH",
    "HttpDatabase",
    "MailroomDatabase",
    "PRIORITIES",
    "SCHEMA",
    "SEED_TASK",
    "STATES",
    "SqliteDatabase",
    "TASK",
    "TITLES",
    "TodoError",
    "TodoStore",
    "now",
    "open_database",
    "register_backend",
    "relative_file",
    "seed_rows",
    "text_field",
    "validate_sha256",
]


class TodoStore:
    """Faceted store wrapper delegating all DB reads/writes through `MailroomDatabase`."""

    def __init__(
        self,
        db: Path | str,
        roadmap: Path,
        output: Path,
        *,
        backend: MailroomDatabase | None = None,
        db_url: str | None = None,
        token: str | None = None,
        backend_spec: str | None = None,
    ):
        self.db = Path(db)
        self.roadmap, self.output = roadmap, output
        if backend is not None:
            self.backend = backend
        else:
            target = db_url if (db_url is not None and str(db_url).strip()) else self.db
            blob_dir = self.db.parent / "blobs"
            self.backend = open_database(target, blob_dir=blob_dir, token=token, backend_spec=backend_spec)

    def backend_info(self) -> dict[str, Any]:
        return self.backend.backend_info()

    def initialized(self) -> bool:
        return self.backend.initialized()

    def connect(self):
        """Legacy SQLite hook reserved solely for SQLite-backend internal diagnostics/tests."""
        fn = getattr(self.backend, "connect", None)
        if fn is None:
            raise TodoError("Direct SQL connections are unavailable on non-SQLite backends", 501)
        return fn()

    def seed(self, cutover: int, *, dry_run: bool = False):
        goals, tasks = seed_rows(self.roadmap)
        res = self.backend.seed(goals, tasks, cutover, dry_run=dry_run)
        if dry_run:
            return res
        return {**res, **self.try_export()}

    def listing(self, *, include_links: bool = False):
        return self.backend.list_state(include_links=include_links)

    def mail_index(self, *, include_tags: bool):
        return self.backend.mail_index(include_tags=include_tags)

    def activity(self, task_id: str | None = None):
        return self.backend.activity(task_id)

    def linked_paths(self) -> set[str]:
        return self.backend.linked_paths()

    def task_membership(self) -> tuple[set[str], set[str], dict[str, str]] | None:
        return self.backend.task_membership()

    def mutate(self, values: dict[str, Any], editor: str, owners: set[str]):
        action = values.get("action")
        if action == "export":
            if editor != "user":
                raise TodoError("This operation requires USER", 403)
            return self.try_export()
        res = self.backend.mutate(values, editor, owners)
        return {**res, **self.try_export()}

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
        return self.backend.upsert_files(
            items,
            prune_prefixes=prune_prefixes,
            keep_paths=keep_paths,
            update_sync_state=update_sync_state,
            source_ref=source_ref,
            source_commit=source_commit,
            editor=editor,
            content_loader=content_loader,
        )

    def get_file_record(self, path: str) -> dict[str, Any] | None:
        return self.backend.get_file_record(path)

    def has_blob(self, sha256: str) -> bool:
        return self.backend.has_blob(sha256)

    def store_verified_blob(self, sha256: str, content: bytes) -> None:
        self.backend.store_verified_blob(sha256, content)

    def read_file_content(self, path: str) -> tuple[dict[str, Any], bytes] | None:
        return self.backend.read_file_content(path)

    def list_file_records(self, prefix: str = "") -> list[dict[str, Any]]:
        return self.backend.list_file_records(prefix=prefix)

    def file_sync_status(self) -> dict[str, Any]:
        return self.backend.file_sync_status()

    def try_export(self):
        try:
            return {"exported": self.export()}
        except OSError as exc:
            return {
                "exported": False,
                "export_warning": f"Task changes are saved. Markdown export failed: {exc.strerror or type(exc).__name__}.",
            }

    def export(self):
        lock = self.db.with_suffix(".export.lock") if self.db.parent.exists() else (self.output.parent / ".goals.export.lock")
        lock.parent.mkdir(parents=True, exist_ok=True)
        with lock.open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            data = self.listing()
            lines = [
                "# Goal status",
                "",
                "Generated from Mailroom. Edit goals and tasks in Mailroom or through the bus CLI.",
                "",
                f"Revision {data['revision']} · {data['updated']}",
                "",
            ]
            by_goal = {goal["id"]: [] for goal in data["goals"]}
            for task in data["tasks"]:
                by_goal[task["goal_id"]].append(task)
            for goal in data["goals"]:
                lines += [f"## {goal['id']} · {goal['title']}", ""]
                for task in by_goal[goal["id"]]:
                    owner = task["owner"] or "unassigned"
                    decision = " · USER decision" if task["decision"] else ""
                    lines.append(
                        f"- **{task['id']}** · {task['title']} ({task['state']} · {owner} · {task['priority']}{decision})"
                    )
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
                with tempfile.NamedTemporaryFile(
                    dir=self.output.parent,
                    prefix=".goal-status-",
                    delete=False,
                    mode="w",
                    encoding="utf-8",
                ) as temp:
                    path = Path(temp.name)
                    temp.write(payload)
                path.chmod(0o644)
                os.replace(path, self.output)
            finally:
                if path is not None:
                    path.unlink(missing_ok=True)
            return True
