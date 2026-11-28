"""Tests for the Mailroom pluggable DB abstraction layer and DB-driven file sync/serving."""
from __future__ import annotations

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

BUS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BUS_DIR))

import db_backend  # noqa: E402
from todo_store import BlobIntegrityError, HttpDatabase, SqliteDatabase, TodoError, TodoStore  # noqa: E402


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)
    return proc.stdout.strip()


def _make_store(root: Path, name: str = "store") -> Path:
    store = root / name
    (store / "bus").mkdir(parents=True)
    (store / "attachments").mkdir()
    (store / "dashboard").mkdir()
    (store / "dashboard" / "index.html").write_text("<html><body>Mailroom</body></html>", encoding="utf-8")
    (store / "bus" / "agents.json").write_text(
        json.dumps(
            {
                "agents": [{"id": "a3", "name": "Worker", "role": "Worker", "machine": "A"}],
                "links": [],
            }
        ),
        encoding="utf-8",
    )
    (store / "bus" / "events.jsonl").write_text("", encoding="utf-8")
    return store


def _load_bus_module(mod_name: str, env: dict[str, str]):
    spec = importlib.util.spec_from_file_location(mod_name, BUS_DIR / "bus.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    prev = os.environ.copy()
    try:
        os.environ.clear()
        os.environ.update(env)
        spec.loader.exec_module(mod)
    finally:
        os.environ.clear()
        os.environ.update(prev)
    return mod


class _StubDbServer:
    """Minimal user-hosted HTTP database facade backed in-process by SqliteDatabase."""

    def __init__(self, inner: SqliteDatabase, token: str = "secret-token"):
        self.inner = inner
        self.token = token
        self.requests: list[str] = []

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def _send(self, code: int, payload: dict):
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _auth_ok(self) -> bool:
                if outer.token and self.headers.get("Authorization") != f"Bearer {outer.token}":
                    self._send(403, {"error": "invalid token"})
                    return False
                return True

            def do_GET(self):
                if not self._auth_ok():
                    return
                parsed = urlparse(self.path)
                qs = parse_qs(parsed.query)
                outer.requests.append(f"GET {parsed.path}")
                try:
                    if parsed.path == "/health":
                        self._send(200, {"initialized": outer.inner.initialized()})
                    elif parsed.path == "/state":
                        inc = qs.get("include_links", ["0"])[0] == "1"
                        self._send(200, outer.inner.list_state(include_links=inc))
                    elif parsed.path == "/mail-index":
                        inc = qs.get("include_tags", ["0"])[0] == "1"
                        self._send(200, outer.inner.mail_index(include_tags=inc))
                    elif parsed.path == "/activity":
                        tags, links = outer.inner.activity(qs.get("task_id", [""])[0] or None)
                        self._send(200, {"tags": tags, "links": links})
                    elif parsed.path == "/linked-paths":
                        self._send(200, {"paths": sorted(outer.inner.linked_paths())})
                    elif parsed.path == "/membership":
                        m = outer.inner.task_membership()
                        if m is None:
                            self._send(200, {"initialized": False})
                        else:
                            a, r, t = m
                            self._send(200, {"initialized": True, "active": sorted(a), "retired": sorted(r), "tags": t})
                    elif parsed.path == "/files/has-blob":
                        sha = qs.get("sha256", [""])[0]
                        self._send(200, {"present": outer.inner.has_blob(sha)})
                    elif parsed.path == "/files/record":
                        rec = outer.inner.get_file_record(qs.get("path", [""])[0])
                        self._send(200, {"record": rec})
                    elif parsed.path == "/files/content":
                        loaded = outer.inner.read_file_content(qs.get("path", [""])[0])
                        if loaded is None:
                            self._send(404, {"error": "not found"})
                        else:
                            rec, raw = loaded
                            self._send(200, {"record": rec, "content_b64": base64.b64encode(raw).decode("ascii")})
                    elif parsed.path == "/files/list":
                        recs = outer.inner.list_file_records(qs.get("prefix", [""])[0])
                        self._send(200, {"records": recs})
                    elif parsed.path == "/files/sync-status":
                        self._send(200, outer.inner.file_sync_status())
                    else:
                        self._send(404, {"error": "unknown endpoint"})
                except TodoError as exc:
                    self._send(exc.status, {"error": str(exc), "current": exc.current})

            def do_POST(self):
                if not self._auth_ok():
                    return
                parsed = urlparse(self.path)
                outer.requests.append(f"POST {parsed.path}")
                length = int(self.headers.get("Content-Length", "0"))
                data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                try:
                    if parsed.path == "/seed":
                        goals = {k: tuple(v) for k, v in data["goals"].items()}
                        tasks = [tuple(x) for x in data["tasks"]]
                        self._send(200, outer.inner.seed(goals, tasks, int(data["cutover"])))
                    elif parsed.path == "/mutate":
                        res = outer.inner.mutate(data["values"], data["editor"], set(data["owners"]))
                        self._send(200, res)
                    elif parsed.path == "/files/blob":
                        raw = base64.b64decode(data["content_b64"])
                        outer.inner.store_verified_blob(data["sha256"], raw)
                        self._send(200, {"stored": True})
                    elif parsed.path == "/files/upsert":
                        items = []
                        for it in data.get("items") or []:
                            item = dict(it)
                            if "content_b64" in item and item["content_b64"] is not None:
                                item["content"] = base64.b64decode(item.pop("content_b64"))
                            items.append(item)
                        update_sync_state = (
                            bool(data["update_sync_state"])
                            if "update_sync_state" in data
                            else bool(data.get("finalize", True))
                        )
                        res = outer.inner.upsert_files(
                            items,
                            prune_prefixes=tuple(data.get("prune_prefixes") or ()),
                            keep_paths=data.get("all_paths"),
                            update_sync_state=update_sync_state,
                            source_ref=str(data.get("source_ref") or ""),
                            source_commit=str(data.get("source_commit") or ""),
                            editor=str(data.get("editor") or ""),
                        )
                        self._send(200, res)
                    else:
                        self._send(404, {"error": "unknown endpoint"})
                except TodoError as exc:
                    self._send(exc.status, {"error": str(exc), "current": exc.current})

        self._srv = ThreadingHTTPServer(("127.0.0.1", _free_port()), Handler)
        self.url = f"http://127.0.0.1:{self._srv.server_port}"
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def stop(self):
        self._srv.shutdown()
        self._srv.server_close()


class DbFileSyncTest(unittest.TestCase):
    def test_no_direct_sqlite_in_bus_or_todo_store(self):
        bus_src = (BUS_DIR / "bus.py").read_text(encoding="utf-8")
        todo_src = (BUS_DIR / "todo_store.py").read_text(encoding="utf-8")
        self.assertNotIn("import sqlite3", bus_src)
        self.assertNotIn("import sqlite3", todo_src)

    def test_legacy_sqlite_migration_adds_file_tables(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db = root / "todo" / "legacy.sqlite3"
            db.parent.mkdir(parents=True)
            conn = sqlite3.connect(db)
            conn.executescript(
                """
                CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL, order_revision INTEGER NOT NULL, cutover INTEGER NOT NULL, cutover_time TEXT NOT NULL, updated TEXT NOT NULL);
                CREATE TABLE goals (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, removed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE tasks (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, number INTEGER NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'todo', owner TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal', next_action TEXT NOT NULL DEFAULT '', blocker TEXT NOT NULL DEFAULT '', decision INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, updated TEXT NOT NULL, editor TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE links (task_id TEXT NOT NULL, path TEXT NOT NULL, editor TEXT NOT NULL, PRIMARY KEY(task_id,path));
                CREATE TABLE tags (event_id TEXT PRIMARY KEY, task_id TEXT);
                INSERT INTO metadata VALUES (1,1,1,0,'2026-11-19T00:00:00+00:00','2026-11-19T00:00:00+00:00');
                INSERT INTO goals VALUES ('G1',1,'Setup',1,0);
                """
            )
            conn.commit()
            conn.close()

            roadmap = root / "GOALS.md"
            roadmap.write_text("## Goal 1. Setup\n- G1.1 `[ ]` Test\n", encoding="utf-8")
            store = TodoStore(db, roadmap, root / "status" / "GOALS_STATUS.md")
            self.assertEqual(store.file_sync_status()["file_count"], 0)
            res = store.upsert_files(
                [{"path": "docs/goals-and-tasks/G1/g1_1_setup/report.pdf", "content": b"%PDF-1.4\nv1\n"}],
                source_ref="main",
                source_commit="a" * 40,
                editor="a3",
            )
            self.assertEqual(res["total_records"], 1)
            loaded = store.read_file_content("docs/goals-and-tasks/G1/g1_1_setup/report.pdf")
            assert loaded is not None
            rec, raw = loaded
            self.assertEqual(raw, b"%PDF-1.4\nv1\n")
            self.assertEqual(rec["source_commit"], "a" * 40)

    def test_custom_registered_and_http_user_hosted_backend(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            roadmap = root / "GOALS.md"
            roadmap.write_text("## Goal 3. Test\n- G3.8 `[~]` Exit extension\n", encoding="utf-8")
            sqlite_db = SqliteDatabase(root / "remote_db" / "tasks.sqlite3")
            stub = _StubDbServer(sqlite_db, token="tok-123").start()
            self.addCleanup(stub.stop)

            seen_scheme: list[str] = []

            def custom_factory(url: str, **kw):
                seen_scheme.append(url)
                http_url = "http://" + url.split("://", 1)[1]
                return HttpDatabase(http_url, token=kw.get("token"))

            db_backend.register_backend("customhttp", custom_factory)
            store = TodoStore(
                root / "unused" / "tasks.sqlite3",
                roadmap,
                root / "status" / "GOALS_STATUS.md",
                db_url="customhttp://" + stub.url.split("://", 1)[1],
                token="tok-123",
            )
            seeded = store.seed(1)
            self.assertTrue(seeded["seeded"])
            self.assertTrue(seen_scheme)
            store.upsert_files(
                [{"path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf", "content": b"%PDF-3pg"}],
                source_ref="main",
                source_commit="b" * 40,
                editor="a3",
            )
            loaded = store.read_file_content("docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf")
            assert loaded is not None
            self.assertEqual(loaded[1], b"%PDF-3pg")
            self.assertTrue(any(r == "POST /files/upsert" for r in stub.requests))

    def test_git_sync_serves_main_over_dirty_dev_with_etag_and_incremental_update(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = root / "repo"
            repo.mkdir()
            _git(repo, "init", "-b", "main")
            _git(repo, "config", "user.email", "test@localhost")
            _git(repo, "config", "user.name", "Tester")

            g38_dir = repo / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension"
            g94_dir = repo / "docs" / "goals-and-tasks" / "G9" / "g9_4_poroelastic_solid"
            (repo / "cases" / "m5").mkdir(parents=True)
            g38_dir.mkdir(parents=True)
            g94_dir.mkdir(parents=True)

            (repo / "docs" / "GOALS.md").write_text(
                "## Goal 3. Squeeze\n- G3.8 `[~]` Exit extension\n## Goal 9. Models\n- G9.4 `[~]` Poro\n",
                encoding="utf-8",
            )
            pdf_v1 = b"%PDF-1.4\nmain-v1-bytes\n"
            pdf_g94 = b"%PDF-1.4\nonly-on-main-g94\n"
            (g38_dir / "g3_8.pdf").write_bytes(pdf_v1)
            (g38_dir / "dossier.md").write_text("---\ntask_id: G3.8\n---\nMain dossier v1\n", encoding="utf-8")
            (g94_dir / "g9_4.pdf").write_bytes(pdf_g94)
            (g94_dir / "context.md").write_text("---\ntask_id: G9.4\n---\nOnly on main G9.4\n", encoding="utf-8")
            (repo / "cases" / "m5" / "note.txt").write_text("workspace-only\n", encoding="utf-8")
            _git(repo, "add", ".")
            _git(repo, "commit", "-m", "initial main v1")
            c_v1 = _git(repo, "rev-parse", "HEAD")

            # Park primary checkout on stale/dirty dev holding old PDF and missing G9.4 folder!
            _git(repo, "checkout", "-b", "dev")
            stale_dev_pdf = b"%PDF-1.4\nstale-dev-2page-copy\n"
            (g38_dir / "g3_8.pdf").write_bytes(stale_dev_pdf)
            _git(repo, "rm", "-rf", "docs/goals-and-tasks/G9/g9_4_poroelastic_solid")
            _git(repo, "commit", "-am", "dev stale snapshot")

            # Advance main to v2 WITHOUT checking out main in REPO_DIR (using separate worktree)
            wt_main = root / "wt_main"
            _git(repo, "worktree", "add", str(wt_main), "main")
            pdf_v2 = b"%PDF-1.4\nmain-v2-3page-updated-bytes\n"
            (wt_main / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension" / "g3_8.pdf").write_bytes(pdf_v2)
            _git(wt_main, "add", ".")
            _git(wt_main, "commit", "-m", "main v2 updated 3-page PDF")
            c_v2 = _git(wt_main, "rev-parse", "HEAD")
            self.assertNotEqual(c_v1, c_v2)
            self.assertEqual((g38_dir / "g3_8.pdf").read_bytes(), stale_dev_pdf)

            store = _make_store(root)
            env = {
                **os.environ,
                "HOME": str(root / "home"),
                "COORD_STORE": str(store),
                "BUS_REPO_DIR": str(repo),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            (root / "home").mkdir()
            subprocess.run([sys.executable, str(BUS_DIR / "bus.py"), "todo", "seed"], env=env, check=True, stdout=subprocess.DEVNULL)

            public, admin = _free_port(), _free_port()
            while admin == public:
                admin = _free_port()
            proc = subprocess.Popen(
                [sys.executable, str(BUS_DIR / "bus.py"), "serve", "--port", str(public), "--admin-port", str(admin)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.addCleanup(proc.wait)
            self.addCleanup(proc.terminate)

            for _ in range(80):
                try:
                    urlopen(f"http://127.0.0.1:{admin}/api/todo", timeout=3).read()
                    break
                except (URLError, TimeoutError):
                    time.sleep(0.05)
            else:
                self.fail("mailroom server failed to start")

            # HTTP POST /api/todo sync-files syncs from main (c_v2) even though repo sits on dev!
            req_sync = Request(
                f"http://127.0.0.1:{admin}/api/todo",
                data=json.dumps({"action": "sync-files", "ref": "auto"}).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(req_sync, timeout=10) as resp:
                sync_res = json.loads(resp.read())["file_sync"]
            self.assertEqual(sync_res["source_commit"], c_v2)
            self.assertEqual((g38_dir / "g3_8.pdf").read_bytes(), stale_dev_pdf)

            # Serve PDF over HTTP -> returns main v2 bytes with DB headers & ETag!
            url_pdf = f"http://127.0.0.1:{public}/repo/docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf"
            with urlopen(url_pdf, timeout=5) as resp:
                got = resp.read()
                self.assertEqual(got, pdf_v2)
                self.assertEqual(resp.headers.get("X-Mailroom-Source"), "db")
                self.assertEqual(resp.headers.get("X-Mailroom-Commit"), c_v2)
                sha_v2 = hashlib.sha256(pdf_v2).hexdigest()
                self.assertEqual(resp.headers.get("X-Mailroom-SHA256"), sha_v2)
                etag = resp.headers.get("ETag")
                self.assertEqual(etag, f'"{sha_v2}"')

            # Conditional If-None-Match -> 304 Not Modified
            req_304 = Request(url_pdf, headers={"If-None-Match": etag})
            with self.assertRaises(HTTPError) as err304:
                urlopen(req_304, timeout=5)
            self.assertEqual(err304.exception.code, 304)
            err304.exception.close()

            # G9.4 file exists ONLY in DB/main (missing on dev), yet /repo/ and /api/repo-dir and /api/todo?id=G9.4 work!
            url_g94 = f"http://127.0.0.1:{public}/repo/docs/goals-and-tasks/G9/g9_4_poroelastic_solid/g9_4.pdf"
            self.assertEqual(urlopen(url_g94, timeout=5).read(), pdf_g94)
            dir_g9 = json.loads(urlopen(f"http://127.0.0.1:{admin}/api/repo-dir?path=docs/goals-and-tasks/G9", timeout=5).read())
            self.assertIn("g9_4_poroelastic_solid", [e["name"] for e in dir_g9["entries"]])
            dir_g94 = json.loads(urlopen(f"http://127.0.0.1:{admin}/api/repo-dir?path=docs/goals-and-tasks/G9/g9_4_poroelastic_solid", timeout=5).read())
            g94_pdf_entry = next(e for e in dir_g94["entries"] if e["name"] == "g9_4.pdf")
            self.assertEqual(g94_pdf_entry["size"], len(pdf_g94))
            self.assertEqual(g94_pdf_entry["source"], "db")

            detail_g94 = json.loads(urlopen(f"http://127.0.0.1:{admin}/api/todo?id=G9.4", timeout=5).read())
            self.assertIn("docs/goals-and-tasks/G9/g9_4_poroelastic_solid/context.md", detail_g94["files"])

            # Non-DB workspace file falls back cleanly to REPO_DIR
            with urlopen(f"http://127.0.0.1:{public}/repo/cases/m5/note.txt", timeout=5) as ws_resp:
                self.assertEqual(ws_resp.read(), b"workspace-only\n")
                self.assertEqual(ws_resp.headers.get("X-Mailroom-Source"), "workspace")

            # Advance main again -> sync picks up v3 and invalidates prior ETag
            pdf_v3 = b"%PDF-1.4\nmain-v3-even-newer\n"
            (wt_main / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension" / "g3_8.pdf").write_bytes(pdf_v3)
            _git(wt_main, "add", ".")
            _git(wt_main, "commit", "-m", "main v3")
            c_v3 = _git(wt_main, "rev-parse", "HEAD")

            req_sync2 = Request(
                f"http://127.0.0.1:{admin}/api/todo",
                data=json.dumps({"action": "sync-files", "ref": "auto"}).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            urlopen(req_sync2, timeout=10).read()
            with urlopen(Request(url_pdf, headers={"If-None-Match": etag}), timeout=5) as resp3:
                self.assertEqual(resp3.read(), pdf_v3)
                self.assertEqual(resp3.headers.get("X-Mailroom-Commit"), c_v3)

            # Reject --source-file over HTTP (403), allow via local CLI
            req_bad_src = Request(
                f"http://127.0.0.1:{admin}/api/todo",
                data=json.dumps({"action": "sync-files", "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf", "source_file": "/etc/passwd"}).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with self.assertRaises(HTTPError) as err_http_src:
                urlopen(req_bad_src, timeout=5)
            self.assertEqual(err_http_src.exception.code, 403)
            err_http_src.exception.close()

            local_override = root / "local_override.pdf"
            local_override.write_bytes(b"%PDF-1.4\nlocal-cli-override\n")
            subprocess.run(
                [
                    sys.executable,
                    str(BUS_DIR / "bus.py"),
                    "todo",
                    "sync-files",
                    "--path",
                    "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf",
                    "--source-file",
                    str(local_override),
                ],
                env=env,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            self.assertEqual(urlopen(url_pdf, timeout=5).read(), b"%PDF-1.4\nlocal-cli-override\n")

            # Tamper blob on disk -> fail CLOSED (500), never silently fall back to stale dev bytes!
            tamper_sha = hashlib.sha256(b"%PDF-1.4\nlocal-cli-override\n").hexdigest()
            bp = store / "todo" / "blobs" / tamper_sha[:2] / tamper_sha
            os.chmod(bp, 0o644)
            bp.write_bytes(b"TAMPERED")
            with self.assertRaises(HTTPError) as err500:
                urlopen(url_pdf, timeout=5)
            self.assertEqual(err500.exception.code, 500)
            err500.exception.close()

    def test_sibling_loader_thread_safety_and_failure_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            store = _make_store(root)
            repo = root / "repo"
            (repo / "docs").mkdir(parents=True)
            (repo / "docs" / "GOALS.md").write_text("## Goal 1. Setup\n- G1.1 `[ ]` Test\n", encoding="utf-8")
            (root / "home").mkdir()
            mod = _load_bus_module(
                "test_bus_thread_race",
                {
                    "HOME": str(root / "home"),
                    "COORD_STORE": str(store),
                    "BUS_REPO_DIR": str(repo),
                    "PYTHONDONTWRITEBYTECODE": "1",
                },
            )
            mod._SIBLING_CACHE.clear()
            tracked_names = ("todo_store", "_mailroom_runtime_todo_store", "db_backend", "_mailroom_runtime_db_backend")
            saved_modules = {name: sys.modules.get(name) for name in tracked_names}
            try:
                for name in tracked_names:
                    sys.modules.pop(name, None)

                n_threads = 12
                barrier = threading.Barrier(n_threads)
                results: list[tuple[Any, Any, Any]] = []
                errors: list[BaseException] = []
                lock = threading.Lock()

                def _worker():
                    try:
                        barrier.wait(timeout=5)
                        ts_mod = mod._sibling_module("todo_store")
                        err_cls = ts_mod.TodoError
                        db_mod = ts_mod._load_db_backend()
                        with lock:
                            results.append((ts_mod, err_cls, db_mod))
                    except BaseException as exc:  # pragma: no cover - captured for assertion
                        with lock:
                            errors.append(exc)

                threads = [threading.Thread(target=_worker) for _ in range(n_threads)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=10)

                self.assertEqual(errors, [])
                self.assertEqual(len(results), n_threads)
                first_ts, first_err, first_db = results[0]
                for ts_mod, err_cls, db_mod in results[1:]:
                    self.assertIs(ts_mod, first_ts)
                    self.assertIs(err_cls, first_err)
                    self.assertIs(db_mod, first_db)
            finally:
                for name, orig in saved_modules.items():
                    if orig is None:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = orig

            # Failure during exec_module must not leak partial module into sys.modules or cache.
            broken_name = "_test_broken_sibling"
            sys.modules.pop(broken_name, None)
            broken_path = BUS_DIR / f"{broken_name}.py"
            broken_path.write_text("PARTIAL = 1\nraise RuntimeError('boom')\n", encoding="utf-8")
            try:
                with self.assertRaisesRegex(RuntimeError, "boom"):
                    mod._sibling_module(broken_name)
                self.assertNotIn(broken_name, sys.modules)
                self.assertNotIn(broken_name, mod._SIBLING_CACHE)
            finally:
                broken_path.unlink(missing_ok=True)
                sys.modules.pop(broken_name, None)
                mod._SIBLING_CACHE.pop(broken_name, None)

    def test_http_multibatch_upsert_preserves_all_batches_and_prunes_stale(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            roadmap = root / "GOALS.md"
            roadmap.write_text("## Goal 3. Test\n- G3.1 `[~]` Multibatch\n", encoding="utf-8")
            sqlite_db = SqliteDatabase(root / "remote_db" / "tasks.sqlite3")
            stub = _StubDbServer(sqlite_db, token="tok-mb").start()
            self.addCleanup(stub.stop)

            store = TodoStore(
                root / "unused" / "tasks.sqlite3",
                roadmap,
                root / "status" / "GOALS_STATUS.md",
                db_url=stub.url,
                token="tok-mb",
            )
            store.seed(1)

            # Pre-seed a stale git record (to be pruned) and a local-file override (exempt from prune).
            stale_path = "docs/goals-and-tasks/G3/g3_1_multibatch/stale.pdf"
            local_path = "docs/goals-and-tasks/G3/g3_1_multibatch/local_override.pdf"
            store.upsert_files(
                [{"path": stale_path, "content": b"%PDF-1.4\nstale\n"}],
                source_ref="main",
                source_commit="a" * 40,
                editor="a3",
            )
            store.upsert_files(
                [{"path": local_path, "content": b"%PDF-1.4\nlocal\n", "source_ref": "local-file", "source_commit": "", "source_blob": ""}],
                update_sync_state=False,
                source_ref="local-file",
                source_commit="",
                editor="user",
            )

            # Upsert 32 files (> 25 batch size -> 2 batches: 25 + 7) with prune_prefixes.
            items_32 = [
                {
                    "path": f"docs/goals-and-tasks/G3/g3_1_multibatch/file_{i:02d}.pdf",
                    "content": f"%PDF-1.4\nitem-{i:02d}\n".encode("utf-8"),
                }
                for i in range(32)
            ]
            stub.requests.clear()
            res = store.upsert_files(
                items_32,
                prune_prefixes=("docs/goals-and-tasks/",),
                source_ref="main",
                source_commit="c" * 40,
                editor="a3",
            )
            upsert_calls = [r for r in stub.requests if r == "POST /files/upsert"]
            self.assertEqual(len(upsert_calls), 2)
            self.assertEqual(res["pruned"], 1)
            self.assertEqual(res["updated"], 32)
            self.assertEqual(res["total_records"], 33)
            self.assertEqual(store.file_sync_status()["source_commit"], "c" * 40)
            self.assertIsNone(store.get_file_record(stale_path))
            self.assertIsNotNone(store.get_file_record(local_path))

            # Verify every single file from both batch 1 (0..24) and batch 2 (25..31) survived!
            for i in range(32):
                loaded = store.read_file_content(f"docs/goals-and-tasks/G3/g3_1_multibatch/file_{i:02d}.pdf")
                self.assertIsNotNone(loaded, f"missing item {i}")
                assert loaded is not None
                self.assertEqual(loaded[1], f"%PDF-1.4\nitem-{i:02d}\n".encode("utf-8"))

            # Updating only batch-1 item while batch 2 is unchanged still reports updated > 0.
            items_32_v2 = [dict(it) for it in items_32]
            items_32_v2[0]["content"] = b"%PDF-1.4\nitem-00-updated\n"
            res2 = store.upsert_files(
                items_32_v2,
                prune_prefixes=("docs/goals-and-tasks/",),
                source_ref="main",
                source_commit="c" * 40,
                editor="a3",
            )
            self.assertEqual(res2["updated"], 1)
            self.assertEqual(res2["unchanged"], 31)
            self.assertEqual(res2["total_records"], 33)

    def test_sync_single_file_preserves_sync_state_and_local_override_and_ref_guard(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = root / "repo"
            repo.mkdir()
            _git(repo, "init", "-b", "main")
            _git(repo, "config", "user.email", "test@localhost")
            _git(repo, "config", "user.name", "Tester")

            g38_dir = repo / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension"
            g38_dir.mkdir(parents=True)
            (repo / "docs" / "GOALS.md").write_text("## Goal 3. Squeeze\n- G3.8 `[~]` Exit extension\n", encoding="utf-8")
            main_v1 = b"%PDF-1.4\nmain-v1\n"
            extra_v1 = b"# Extra v1\n"
            (g38_dir / "g3_8.pdf").write_bytes(main_v1)
            (g38_dir / "notes.md").write_bytes(extra_v1)
            (repo / "workspace_only.md").write_text("# Workspace note\n", encoding="utf-8")
            _git(repo, "add", "docs")
            _git(repo, "commit", "-m", "main v1")
            c_v1 = _git(repo, "rev-parse", "HEAD")

            # Create an unmerged dev branch with different PDF content.
            _git(repo, "checkout", "-b", "dev")
            dev_pdf = b"%PDF-1.4\nunmerged-dev-branch\n"
            (g38_dir / "g3_8.pdf").write_bytes(dev_pdf)
            _git(repo, "commit", "-am", "dev unmerged branch")

            wt_main = root / "wt_main"
            _git(repo, "worktree", "add", str(wt_main), "main")

            store = _make_store(root)
            (root / "home").mkdir()
            env = {
                **os.environ,
                "HOME": str(root / "home"),
                "COORD_STORE": str(store),
                "BUS_REPO_DIR": str(repo),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            subprocess.run([sys.executable, str(BUS_DIR / "bus.py"), "todo", "seed"], env=env, check=True, stdout=subprocess.DEVNULL)

            bus_mod = _load_bus_module("test_bus_bug3_bug4", env)
            res_sync = bus_mod.sync_repo_files(ref="auto", editor="user")
            self.assertEqual(res_sync["source_commit"], c_v1)
            self.assertEqual(bus_mod.todo_store().file_sync_status()["source_commit"], c_v1)

            # Bug 3a: sync_single_file (--source-file and workspace link fallback) must NOT clobber file_sync_state.
            override_file = root / "override.pdf"
            override_bytes = b"%PDF-1.4\nlocal-file-override\n"
            override_file.write_bytes(override_bytes)
            bus_mod.sync_single_file(
                "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf",
                source_file=str(override_file),
                editor="user",
            )
            bus_mod.sync_single_file("workspace_only.md", editor="a3", strict=False)
            sync_status = bus_mod.todo_store().file_sync_status()
            self.assertEqual(sync_status["source_commit"], c_v1)
            self.assertEqual(sync_status["source_ref"], "main")

            # Bug 3b: simulated file_sync_loop tick (both unchanged and advanced main) preserves local-file override!
            tick_unchanged = bus_mod.sync_repo_files(ref="auto", editor="auto-sync", only_if_changed=True)
            self.assertEqual(tick_unchanged["reason"], "unchanged")

            main_v2 = b"%PDF-1.4\nmain-v2-must-not-clobber-local\n"
            extra_v2 = b"# Extra v2\n"
            (wt_main / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension" / "g3_8.pdf").write_bytes(main_v2)
            (wt_main / "docs" / "goals-and-tasks" / "G3" / "g3_8_exit_station_extension" / "notes.md").write_bytes(extra_v2)
            _git(wt_main, "add", ".")
            _git(wt_main, "commit", "-m", "main v2")
            c_v2 = _git(wt_main, "rev-parse", "HEAD")

            tick_advanced = bus_mod.sync_repo_files(ref="auto", editor="auto-sync", only_if_changed=True)
            self.assertEqual(tick_advanced["source_commit"], c_v2)
            loaded_override = bus_mod.todo_store().read_file_content("docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf")
            loaded_notes = bus_mod.todo_store().read_file_content("docs/goals-and-tasks/G3/g3_8_exit_station_extension/notes.md")
            assert loaded_override is not None and loaded_notes is not None
            self.assertEqual(loaded_override[0]["source_ref"], "local-file")
            self.assertEqual(loaded_override[1], override_bytes)
            self.assertEqual(loaded_notes[1], extra_v2)

            # Linking that path must also keep the local-file override intact.
            bus_mod.todo_mutation(
                {
                    "action": "link",
                    "id": "G3.8",
                    "agent": "a3",
                    "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf",
                },
                admin=False,
            )
            after_link = bus_mod.todo_store().read_file_content("docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf")
            assert after_link is not None
            self.assertEqual(after_link[0]["source_ref"], "local-file")
            self.assertEqual(after_link[1], override_bytes)

            # Bug 4: live HTTP server rejects non-admin explicit ref overrides with 403 on both sync-files and link.
            public, admin = _free_port(), _free_port()
            while admin == public:
                admin = _free_port()
            proc = subprocess.Popen(
                [sys.executable, str(BUS_DIR / "bus.py"), "serve", "--port", str(public), "--admin-port", str(admin)],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.addCleanup(proc.wait)
            self.addCleanup(proc.terminate)

            for _ in range(80):
                try:
                    urlopen(f"http://127.0.0.1:{admin}/api/todo", timeout=3).read()
                    break
                except (URLError, TimeoutError):
                    time.sleep(0.05)
            else:
                self.fail("mailroom server failed to start")

            def _post_todo(port: int, payload: dict) -> tuple[int, dict]:
                req = Request(
                    f"http://127.0.0.1:{port}/api/todo",
                    data=json.dumps(payload).encode("utf-8"),
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
                try:
                    with urlopen(req, timeout=5) as resp:
                        return resp.status, json.loads(resp.read())
                except HTTPError as exc:
                    body = json.loads(exc.read().decode("utf-8") or "{}")
                    exc.close()
                    return exc.code, body

            for bad_payload in (
                {"action": "sync-files", "agent": "a3", "ref": "dev"},
                {"action": "sync-files", "agent": "a3", "ref": "main"},
                {"action": "sync-files", "agent": "a3", "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/notes.md", "ref": "dev"},
                {"action": "link", "id": "G3.8", "agent": "a3", "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/notes.md", "ref": "dev"},
                {"action": "sync-files", "agent": "a3", "overwrite_local": True},
            ):
                code, body = _post_todo(public, bad_payload)
                self.assertEqual(code, 403, f"expected 403 for {bad_payload}, got {code}: {body}")

            # Ensure the rejected link mutation did NOT persist notes.md into G3.8 links.
            detail_after_403 = json.loads(urlopen(f"http://127.0.0.1:{admin}/api/todo?id=G3.8", timeout=5).read())
            self.assertNotIn("docs/goals-and-tasks/G3/g3_8_exit_station_extension/notes.md", detail_after_403["manual_files"])

            # Non-admin ref="auto" and ref=None on public port succeed cleanly against canonical main.
            code_auto, body_auto = _post_todo(public, {"action": "sync-files", "agent": "a3", "ref": "auto"})
            self.assertEqual(code_auto, 200, body_auto)
            self.assertEqual(body_auto["file_sync"]["source_commit"], c_v2)

            code_link_ok, _ = _post_todo(
                public,
                {"action": "link", "id": "G3.8", "agent": "a3", "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/notes.md", "ref": "auto"},
            )
            self.assertEqual(code_link_ok, 200)

            # Admin port CAN use explicit --ref dev and --overwrite-local when explicitly requested.
            code_adm_dev, _ = _post_todo(
                admin,
                {"action": "sync-files", "path": "docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf", "ref": "dev", "overwrite_local": True},
            )
            self.assertEqual(code_adm_dev, 200)
            self.assertEqual(
                urlopen(f"http://127.0.0.1:{public}/repo/docs/goals-and-tasks/G3/g3_8_exit_station_extension/g3_8.pdf", timeout=5).read(),
                dev_pdf,
            )


if __name__ == "__main__":
    unittest.main()
