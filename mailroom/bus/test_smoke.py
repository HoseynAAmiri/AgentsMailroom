"""Exercise the standalone setup and server with an isolated store and no agent CLI."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "mailroom/run.sh"
CLIENT = ROOT / "mailroom/bus/bus_client.py"


def local_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class StandaloneSmoke(unittest.TestCase):
    def test_clean_store_round_trip(self):
        with tempfile.TemporaryDirectory() as fixture:
            self.exercise(Path(fixture))

    def exercise(self, fixture):
        store = fixture / "data"
        workspace = fixture / "workspace"
        demo_dir = workspace / "docs" / "goals-and-tasks" / "G1" / "g1_1_demo"
        demo_dir.mkdir(parents=True)
        (demo_dir / "context.md").write_text("# Demo G1.1 context\n")
        web = fixture / "web"
        web.mkdir()
        (web / "index.html").write_text("<title>Mailroom smoke fixture</title>")
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("BUS_")}
        env.update(COORD_STORE=str(store), BUS_DASHBOARD_DIR=str(web), BUS_REPO_DIR=str(workspace),
                   PYTHON=sys.executable, PYTHONDONTWRITEBYTECODE="1")
        for seeded in (True, False):
            output = subprocess.check_output([RUN, "init"], env=env)
            self.assertEqual(json.loads(output)["seeded"], seeded)
        self.assertTrue((store / "status/GOALS_STATUS.md").is_file())

        public, admin = local_port(), local_port()
        while admin == public:
            admin = local_port()
        env["BUS_URL"] = f"http://127.0.0.1:{public}"

        def read(port, path, *, post=None, headers=None):
            payload = json.dumps(post).encode() if isinstance(post, dict) else post
            request = Request(f"http://127.0.0.1:{port}{path}", data=payload,
                              headers=headers or {})
            with urlopen(request, timeout=3) as reply:
                content = reply.read()
                if reply.headers.get_content_type() == "application/json":
                    return json.loads(content)
                return content

        def client(*args):
            output = subprocess.check_output([sys.executable, CLIENT, *args],
                                             env=env, timeout=8)
            return json.loads(output)

        with (fixture / "server.log").open("w+") as log:
            server = subprocess.Popen([RUN, "serve", "--port", str(public),
                                       "--admin-port", str(admin)], env=env,
                                      stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        goals = read(admin, "/api/todo")
                        break
                    except URLError:
                        if server.poll() is not None:
                            log.seek(0)
                            self.fail(log.read())
                        time.sleep(.05)
                else:
                    self.fail("Mailroom did not start")
                self.assertEqual(goals["tasks"][0]["id"], "G1.1")
                self.assertIn(b"Mailroom smoke fixture", read(admin, "/"))
                with self.assertRaises(HTTPError) as denied:
                    read(public, "/api/agents", post={"id": "worker"})
                self.assertEqual(denied.exception.code, 403)

                for agent in ("coordinator", "worker"):
                    read(admin, "/api/agents", post={"id": agent, "name": agent})
                read(admin, "/api/links", post={"links": [{"a": "coordinator", "b": "worker"}]})
                roster = client("team")
                self.assertEqual([m["id"] for m in roster["members"]], ["coordinator", "worker"])
                self.assertEqual(roster["links"], [{"a": "coordinator", "b": "worker", "note": ""}])
                msg = client("post", "--from", "coordinator", "--to", "worker",
                             "--task-id", "G1.1", "--body", "Please review the starter task.")
                event_id = msg["id"]
                wake = subprocess.check_output(
                    [sys.executable, ROOT / "mailroom/bus/watch_inbox.py", "--agent", "worker",
                     "--thread", "test-session", "--codex", "/unused/codex", "--dry-run"],
                    env=env, timeout=8)
                self.assertEqual(json.loads(wake)["new_ids"], [event_id])
                self.assertEqual(client("wait", "--agent", "worker", "--timeout", "1")[0]["id"], event_id)
                self.assertEqual(client("search", "--agent", "worker", "--q", "starter")["messages"][0]["id"], event_id)
                subprocess.run([sys.executable, CLIENT, "mark-seen", "--agent", "worker",
                                "--event-id", event_id], env=env, check=True,
                               stdout=subprocess.DEVNULL, timeout=8)
                self.assertEqual(client("inbox", "--agent", "worker"), [])

                revision = str(client("todo", "show", "G1.1")["task"]["revision"])
                client("todo", "update", "G1.1", "--agent", "worker",
                       "--revision", revision, "--state", "doing")
                self.assertEqual(client("todo", "show", "G1.1")["task"]["state"], "doing")
                uploaded = read(admin, "/api/attachments?task_id=G1.1", post=b"Review note",
                                headers={"X-Filename": "note.txt"})
                self.assertEqual(read(admin, "/attach/" + uploaded["name"]), b"Review note")
                detail = read(admin, "/api/todo?id=G1.1")
                self.assertIn(uploaded["name"], json.dumps(detail))
                read(admin, "/api/todo", post={"action": "link", "id": "G1.1", "path": "docs/goals-and-tasks/G1/g1_1_demo/context.md"})
                goals_after = read(admin, "/api/todo")
                admin_links = goals_after["tasks"][0]["links"]
                self.assertIn("docs/goals-and-tasks/G1/g1_1_demo/context.md", admin_links)
                self.assertIn(f"coordination/attachments/{uploaded['name']}", admin_links)
                goals_pub = read(public, "/api/todo")
                self.assertNotIn("links", goals_pub["tasks"][0])
                self.assertNotIn(uploaded["name"], json.dumps(goals_pub))
                detail_pub = read(public, "/api/todo?id=G1.1")
                self.assertNotIn("links", detail_pub["task"])
                self.assertNotIn(uploaded["name"], json.dumps(detail_pub))
                self.assertNotIn("docs/goals-and-tasks/G1/g1_1_demo/context.md", json.dumps(detail_pub))

                with self.assertRaises(HTTPError) as denied_dir:
                    read(public, "/api/repo-dir?path=docs/goals-and-tasks/G1/g1_1_demo")
                self.assertEqual(denied_dir.exception.code, 403)
                docs_listing = read(admin, "/api/repo-dir?path=docs/goals-and-tasks/G1/g1_1_demo")
                self.assertEqual(docs_listing["path"], "docs/goals-and-tasks/G1/g1_1_demo")
                self.assertEqual(docs_listing["abs_path"], str(demo_dir.resolve()))
                self.assertTrue(any(e["name"] == "context.md" and e["viewable"] for e in docs_listing["entries"]))
                with self.assertRaises(HTTPError) as bad_dir:
                    read(admin, "/api/repo-dir?path=../bus")
                self.assertEqual(bad_dir.exception.code, 404)

                agents_file = store / "bus" / "agents.json"
                seeded_agent = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "name": "Role Probe",
                    "role": "orchestrator",
                    "role_preset": "orchestrator",
                })
                initial_updated_at = seeded_agent["updated_at"]
                prev_mtime = agents_file.stat().st_mtime_ns
                snap_full = read(admin, "/api/snapshot")
                snap_inc_qs = (
                    f"/api/snapshot?after={snap_full['last_id']}"
                    f"&cursor={snap_full['event_cursor']}"
                    f"&tasks_after={snap_full['tasks_revision']}"
                )

                updated = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "orchestrator",
                    "role_preset": "reviewer",
                })
                self.assertEqual(updated["role"], "reviewer")
                self.assertEqual(updated["role_preset"], "reviewer")
                self.assertEqual(updated["updated_at"], initial_updated_at)
                self.assertGreater(agents_file.stat().st_mtime_ns, prev_mtime)

                reg_entry = next(a for a in read(admin, "/api/agents")["agents"] if a["id"] == "role_probe")
                self.assertEqual((reg_entry["role"], reg_entry["role_preset"]), ("reviewer", "reviewer"))
                snap_after_full = next(a for a in read(admin, "/api/snapshot")["agents"] if a["id"] == "role_probe")
                snap_after_inc = next(a for a in read(admin, snap_inc_qs)["agents"] if a["id"] == "role_probe")
                self.assertEqual((snap_after_full["role"], snap_after_full["role_preset"]), ("reviewer", "reviewer"))
                self.assertEqual((snap_after_inc["role"], snap_after_inc["role_preset"]), ("reviewer", "reviewer"))

                custom_lead = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "custom_lead",
                    "role_preset": None,
                })
                self.assertEqual(custom_lead["role"], "custom_lead")
                self.assertIsNone(custom_lead["role_preset"])

                read(admin, "/api/agents", post={"id": "role_probe", "role": "orchestrator", "role_preset": "orchestrator"})
                synced_preset = read(admin, "/api/agents", post={"id": "role_probe", "role": "reviewer"})
                self.assertEqual((synced_preset["role"], synced_preset["role_preset"]), ("reviewer", "reviewer"))
                cleared_preset = read(admin, "/api/agents", post={"id": "role_probe", "role": "custom_only"})
                self.assertEqual(cleared_preset["role"], "custom_only")
                self.assertIsNone(cleared_preset["role_preset"])
                rebound_preset = read(admin, "/api/agents", post={"id": "role_probe", "role": "Worker"})
                self.assertEqual((rebound_preset["role"], rebound_preset["role_preset"]), ("worker", "worker"))

                # Legacy saved-default fixture: stored preset prompt does not shadow newly typed/selected preset.
                bus_dir = str(ROOT / "mailroom/bus")
                if bus_dir not in sys.path:
                    sys.path.insert(0, bus_dir)
                import bus
                legacy_default = bus.ROLE_PRESETS["orchestrator"]["prompt"]
                read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "orchestrator",
                    "role_preset": "orchestrator",
                    "role_prompt": legacy_default,
                })
                typed_switch = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "reviewer",
                    "role_preset": "reviewer",
                    "role_prompt": legacy_default,
                })
                self.assertEqual((typed_switch["role"], typed_switch["role_preset"]), ("reviewer", "reviewer"))
                self.assertIsNone(typed_switch["role_prompt"])
                self.assertEqual(bus.role_text(typed_switch), bus.ROLE_PRESETS["reviewer"]["prompt"])
                snap_typed = next(a for a in read(admin, "/api/snapshot")["agents"] if a["id"] == "role_probe")
                reg_typed = next(a for a in read(admin, "/api/agents")["agents"] if a["id"] == "role_probe")
                self.assertIsNone(snap_typed["role_prompt"])
                self.assertIsNone(reg_typed["role_prompt"])

                read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "orchestrator",
                    "role_preset": "orchestrator",
                    "role_prompt": legacy_default,
                })
                role_only_switch = read(admin, "/api/agents", post={"id": "role_probe", "role": "worker"})
                self.assertEqual((role_only_switch["role"], role_only_switch["role_preset"]), ("worker", "worker"))
                self.assertIsNone(role_only_switch["role_prompt"])
                self.assertEqual(bus.role_text(role_only_switch), bus.ROLE_PRESETS["worker"]["prompt"])

                # Explicit cross-preset role_prompt survives unrelated edits, same-role saves, and role switches.
                read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "reviewer",
                    "role_preset": "reviewer",
                    "role_prompt": legacy_default,
                })
                unrelated_save = read(admin, "/api/agents", post={"id": "role_probe", "name": "Renamed Probe"})
                self.assertEqual((unrelated_save["role"], unrelated_save["role_preset"]), ("reviewer", "reviewer"))
                self.assertEqual(unrelated_save["role_prompt"], legacy_default)
                self.assertEqual(bus.role_text(unrelated_save), legacy_default)

                same_role_cross = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "reviewer",
                    "role_preset": "reviewer",
                    "role_prompt": legacy_default,
                })
                self.assertEqual(same_role_cross["role_prompt"], legacy_default)
                self.assertEqual(bus.role_text(same_role_cross), legacy_default)

                switched_cross = read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "worker",
                    "role_preset": "worker",
                    "role_prompt": legacy_default,
                })
                self.assertEqual((switched_cross["role"], switched_cross["role_preset"]), ("worker", "worker"))
                self.assertEqual(switched_cross["role_prompt"], legacy_default)
                self.assertEqual(bus.role_text(switched_cross), legacy_default)

                # Genuine custom role_prompt survives switching via role_preset or role-only patch.
                read(admin, "/api/agents", post={
                    "id": "role_probe",
                    "role": "reviewer",
                    "role_preset": "reviewer",
                    "role_prompt": "Custom reviewer override.",
                })
                preset_custom = read(admin, "/api/agents", post={"id": "role_probe", "role": "orchestrator", "role_preset": "orchestrator"})
                self.assertEqual((preset_custom["role"], preset_custom["role_preset"]), ("orchestrator", "orchestrator"))
                self.assertEqual(bus.role_text(preset_custom), "Custom reviewer override.")
                role_only_custom = read(admin, "/api/agents", post={"id": "role_probe", "role": "worker"})
                self.assertEqual((role_only_custom["role"], role_only_custom["role_preset"]), ("worker", "worker"))
                self.assertEqual(bus.role_text(role_only_custom), "Custom reviewer override.")

                with self.assertRaises(HTTPError) as bad_preset:
                    read(admin, "/api/agents", post={"id": "role_probe", "role_preset": "not_a_preset"})
                self.assertEqual(bad_preset.exception.code, 400)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
