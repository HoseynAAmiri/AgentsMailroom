"""Unit and integration tests for generic store resolution, path boundaries, and defaults."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BUS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BUS_DIR))
import coord_store  # noqa: E402


def make_store(root: Path, name: str = "store") -> Path:
    store = root / name
    (store / "bus").mkdir(parents=True)
    (store / "attachments").mkdir()
    (store / "dashboard").mkdir()
    (store / "dashboard" / "index.html").write_text("<html><body>Mailroom</body></html>", encoding="utf-8")
    (store / "bus" / "agents.json").write_text(
        json.dumps(
            {
                "agents": [{"id": "coordinator"}, {"id": "worker"}],
                "links": [{"a": "coordinator", "b": "worker"}],
            }
        ),
        encoding="utf-8",
    )
    return store


def load_bus_module(name: str, env: dict[str, str]):
    spec = importlib.util.spec_from_file_location(name, BUS_DIR / "bus.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, env, clear=True):
        spec.loader.exec_module(mod)
    return mod


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ResolveStoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.app_dir = self.root / "checkout"
        (self.app_dir / "mailroom" / "bus").mkdir(parents=True)
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = {"HOME": str(self.home)}

    def resolve(self, **extra):
        return coord_store.resolve_store({**self.env, **extra}, app_dir=self.app_dir)

    def test_precedence_env_local_user_default_inplace(self):
        default = self.app_dir / ".mailroom-data"
        self.assertEqual(self.resolve(), (default, "default-missing"))

        (self.app_dir / "bus").mkdir()
        (self.app_dir / "attachments").mkdir()
        self.assertEqual(self.resolve(), (self.app_dir, "in-place"))

        default.mkdir()
        self.assertEqual(self.resolve(), (default, "default"))

        user_cfg = self.home / ".config" / "agents-mailroom" / "coord_store"
        user_cfg.parent.mkdir(parents=True)
        user_cfg.write_text("# comment\n\n~/user-store\n", encoding="utf-8")
        self.assertEqual(self.resolve(), (self.home / "user-store", "user-config"))

        (self.app_dir / "coord_store.local").write_text("../local_store\n", encoding="utf-8")
        self.assertEqual(self.resolve(), (self.root / "local_store", "local-config"))

        self.assertEqual(self.resolve(COORD_STORE="~/env-store"), (self.home / "env-store", "env"))

    def test_xdg_and_app_name_override(self):
        cfg = self.root / "xdg" / "custom-app" / "coord_store"
        cfg.parent.mkdir(parents=True)
        cfg.write_text(str(self.root / "from-xdg") + "\n", encoding="utf-8")
        res = coord_store.resolve_store(
            {**self.env, "XDG_CONFIG_HOME": str(self.root / "xdg"), "COORD_STORE_APP": "custom-app"},
            app_dir=self.app_dir,
        )
        self.assertEqual(res, (self.root / "from-xdg", "user-config"))
        res_kw = coord_store.resolve_store(
            {**self.env, "XDG_CONFIG_HOME": str(self.root / "xdg")},
            app_dir=self.app_dir,
            config_app="custom-app",
        )
        self.assertEqual(res_kw, (self.root / "from-xdg", "user-config"))

    def test_cli_show_check_and_usage(self):
        store = make_store(self.root)
        env = {"HOME": str(self.home), "COORD_STORE": str(store), "PYTHONDONTWRITEBYTECODE": "1"}

        r_default = subprocess.run(
            [sys.executable, str(BUS_DIR / "coord_store.py")],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        self.assertEqual(r_default.stdout.strip(), f"{store}\tenv")

        r_show = subprocess.run(
            [sys.executable, str(BUS_DIR / "coord_store.py"), "show"],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        self.assertEqual(r_show.stdout.strip(), f"{store}\tenv")

        r_ok = subprocess.run(
            [sys.executable, str(BUS_DIR / "coord_store.py"), "check"],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(r_ok.returncode, 0, r_ok.stdout + r_ok.stderr)
        self.assertIn(f"store={store} source=env missing=none", r_ok.stdout)

        incomplete = self.root / "incomplete"
        incomplete.mkdir()
        (incomplete / "bus").mkdir()
        r_miss = subprocess.run(
            [sys.executable, str(BUS_DIR / "coord_store.py"), "check"],
            env={**env, "COORD_STORE": str(incomplete)},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(r_miss.returncode, 1)
        self.assertIn("missing=attachments", r_miss.stdout)

        r_bad = subprocess.run(
            [sys.executable, str(BUS_DIR / "coord_store.py"), "bogus"],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(r_bad.returncode, 2)
        self.assertIn("Usage:", r_bad.stderr)


class BoundaryAndDefaultsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root / "workspace"
        (self.repo / "docs").mkdir(parents=True)
        (self.repo / "docs" / "GOALS.md").write_text("## Goal 1. Setup\n- G1.1 `[ ]` Verify boundaries\n", encoding="utf-8")
        (self.repo / "docs" / "ok.md").write_text("---\ntask_id: G1.1\n---\nVisible workspace doc\n", encoding="utf-8")
        (self.repo / ".secret.md").write_text("---\ntask_id: G1.1\n---\nHidden workspace file\n", encoding="utf-8")

        # Place store inside workspace under a non-hidden directory name to catch symlink leaks.
        self.store = make_store(self.repo, name="store")
        (self.store / "attachments" / "note.md").write_text("---\ntask_id: G1.1\n---\nPublic attachment\n", encoding="utf-8")
        (self.store / "attachments" / ".hidden.md").write_text("Hidden attachment\n", encoding="utf-8")
        (self.store / "attachments" / "escape.json").symlink_to(self.store / "bus" / "agents.json")

        (self.repo / "escape_store.json").symlink_to(self.store / "bus" / "agents.json")
        (self.repo / "escape_hidden.md").symlink_to(self.repo / ".secret.md")
        (self.repo / "docs" / "doc_escape_store.md").symlink_to(self.store / "bus" / "agents.json")
        (self.repo / "docs" / "doc_escape_hidden.md").symlink_to(self.repo / ".secret.md")

        self.env = {
            "HOME": str(self.root / "home"),
            "COORD_STORE": str(self.store),
            "BUS_REPO_DIR": str(self.repo),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        (self.root / "home").mkdir()

    def test_generic_defaults(self):
        mod = load_bus_module("test_bus_defaults", self.env)
        self.assertEqual(mod.DEFAULT_LINKS, [])
        self.assertEqual([m["id"] for m in mod.DEFAULT_MACHINES], ["A"])
        self.assertEqual(mod.DEFAULT_MACHINES[0]["kind"], "local")
        self.assertEqual(mod.STORE_SOURCE, "env")
        self.assertEqual(mod.STORE_DIR, self.store.resolve())
        self.assertEqual(mod.REPO_DIR, self.repo.resolve())

    def test_viewable_path_and_logical_file(self):
        mod = load_bus_module("test_bus_paths", self.env)
        f_att, r_att = mod.logical_file("coordination/attachments/note.md")
        self.assertEqual((f_att, r_att), (self.store / "attachments" / "note.md", self.store / "attachments"))
        self.assertTrue(mod.viewable_path(f_att, r_att))

        self.assertFalse(mod.viewable_path(self.store / "attachments" / ".hidden.md", r_att))
        self.assertFalse(mod.viewable_path(self.store / "attachments" / "escape.json", r_att))

        f_doc, r_doc = mod.logical_file("docs/ok.md")
        self.assertEqual(r_doc, self.repo.resolve())
        self.assertTrue(mod.viewable_path(f_doc, r_doc))
        self.assertFalse(mod.viewable_path(self.repo / "escape_store.json", r_doc))
        self.assertFalse(mod.viewable_path(self.repo / "escape_hidden.md", r_doc))
        self.assertFalse(mod.viewable_path(self.store / "attachments" / "note.md", r_doc))

    def test_todo_store_seed_and_documents(self):
        mod = load_bus_module("test_bus_todo_seed", self.env)
        todo = mod.todo_store()
        self.assertEqual(todo.roadmap, self.repo / "docs" / "GOALS.md")
        self.assertEqual(todo.output, self.store / "status" / "GOALS_STATUS.md")

        docs = mod.todo_documents(0)
        labels = [row[0] for row in docs]
        self.assertIn("docs/ok.md", labels)
        self.assertIn("coordination/attachments/note.md", labels)
        self.assertNotIn("docs/doc_escape_store.md", labels)
        self.assertNotIn("docs/doc_escape_hidden.md", labels)
        self.assertNotIn(".secret.md", labels)

        # Without REPO_DIR/docs/GOALS.md, fallback uses APP_DIR/docs/GOALS.md.
        empty_repo = self.root / "empty_workspace"
        empty_repo.mkdir()
        mod_fallback = load_bus_module("test_bus_todo_fallback", {**self.env, "BUS_REPO_DIR": str(empty_repo)})
        self.assertEqual(mod_fallback.todo_store().roadmap, mod_fallback.APP_DIR / "docs" / "GOALS.md")

    def test_http_boundaries_and_generic_state(self):
        subprocess.run([sys.executable, str(BUS_DIR / "bus.py"), "todo", "seed"], env=self.env, check=True, stdout=subprocess.DEVNULL)
        public, admin = free_port(), free_port()
        while admin == public:
            admin = free_port()
        proc = subprocess.Popen(
            [sys.executable, str(BUS_DIR / "bus.py"), "serve", "--port", str(public), "--admin-port", str(admin)],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)

        for _ in range(80):
            try:
                urlopen(f"http://127.0.0.1:{admin}/api/snapshot", timeout=1).read()
                break
            except URLError:
                time.sleep(0.05)
        else:
            self.fail("bus server failed to start")

        state = json.loads(urlopen(f"http://127.0.0.1:{public}/api/snapshot", timeout=5).read())
        self.assertEqual(state["channels"], [])
        self.assertEqual(state["processes"], [])

        # Workspace endpoints
        self.assertIn(b"Visible workspace doc", urlopen(f"http://127.0.0.1:{public}/repo/docs/ok.md", timeout=5).read())
        self.assertIn(
            b"Public attachment",
            urlopen(f"http://127.0.0.1:{public}/repo/coordination/attachments/note.md", timeout=5).read(),
        )
        for blocked in (
            "/repo/escape_store.json",
            "/repo/escape_hidden.md",
            "/repo/.secret.md",
            "/repo/store/bus/agents.json",
            "/attach/.hidden.md",
            "/attach/escape.json",
        ):
            with self.assertRaises(HTTPError, msg=f"expected 404 for {blocked}") as err:
                urlopen(f"http://127.0.0.1:{public}{blocked}", timeout=5)
            self.assertEqual(err.exception.code, 404)
            err.exception.close()

        self.assertIn(b"Public attachment", urlopen(f"http://127.0.0.1:{public}/attach/note.md", timeout=5).read())
        listed = json.loads(urlopen(f"http://127.0.0.1:{public}/api/attachments?refresh=1", timeout=5).read())
        self.assertEqual([row["name"] for row in listed], ["note.md"])

        def post_todo(payload: dict):
            req = Request(
                f"http://127.0.0.1:{admin}/api/todo",
                data=json.dumps(payload).encode("utf-8"),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            with urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())

        post_todo({"action": "link", "id": "G1.1", "path": "docs/ok.md"})
        post_todo({"action": "link", "id": "G1.1", "path": "coordination/attachments/note.md"})
        detail = json.loads(urlopen(f"http://127.0.0.1:{admin}/api/todo?id=G1.1", timeout=5).read())
        self.assertIn("docs/ok.md", detail["files"])
        self.assertIn("coordination/attachments/note.md", detail["files"])
        for bad_link in ("escape_store.json", "escape_hidden.md", "../outside.md"):
            with self.assertRaises(HTTPError, msg=f"expected 400 for link {bad_link}") as err:
                post_todo({"action": "link", "id": "G1.1", "path": bad_link})
            self.assertEqual(err.exception.code, 400)
            err.exception.close()

    def test_missing_store_refused_and_ingress_gate(self):
        missing = self.root / "missing-store"
        r = subprocess.run(
            [sys.executable, str(BUS_DIR / "bus.py"), "inbox", "--agent", "worker"],
            env={**self.env, "COORD_STORE": str(missing)},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(r.returncode, 2)
        self.assertIn("bus data folder not found", r.stderr)
        self.assertFalse(missing.exists())

        (self.store / "bus" / ".ingress_closed").touch()
        gated = subprocess.run(
            [sys.executable, str(BUS_DIR / "bus.py"), "post", "--from", "coordinator", "--to", "worker", "--body", "hi"],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(gated.returncode, 75)
        override = subprocess.run(
            [sys.executable, str(BUS_DIR / "bus.py"), "post", "--from", "coordinator", "--to", "worker", "--body", "ok"],
            env={**self.env, "BUS_INGRESS_OVERRIDE": "1"},
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(override.returncode, 0, override.stderr)

        port = free_port()
        proc = subprocess.Popen(
            [sys.executable, str(BUS_DIR / "bus.py"), "serve", "--port", str(port), "--admin-port", "0"],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        for _ in range(80):
            try:
                urlopen(f"http://127.0.0.1:{port}/api/agents", timeout=1).read()
                break
            except URLError:
                time.sleep(0.05)
        else:
            self.fail("gated bus server failed to start")
        req = Request(
            f"http://127.0.0.1:{port}/api/events",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=json.dumps({"type": "message", "from": "coordinator", "to": "worker", "body": "x"}).encode("utf-8"),
        )
        with self.assertRaises(HTTPError) as err:
            urlopen(req, timeout=5)
        self.assertEqual(err.exception.code, 503)
        err.exception.close()
        with urlopen(f"http://127.0.0.1:{port}/api/agents", timeout=5) as resp:
            self.assertEqual(resp.status, 200)


if __name__ == "__main__":
    unittest.main()
