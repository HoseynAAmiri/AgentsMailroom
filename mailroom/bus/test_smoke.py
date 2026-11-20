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
                self.assertTrue(any(e["name"] == "context.md" and e["viewable"] for e in docs_listing["entries"]))
                with self.assertRaises(HTTPError) as bad_dir:
                    read(admin, "/api/repo-dir?path=../bus")
                self.assertEqual(bad_dir.exception.code, 404)
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
