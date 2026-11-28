"""Backend and HTTP API tests for resolving human.needed items by click without a text reply."""
from __future__ import annotations

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


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ResolveHumanByClickTest(unittest.TestCase):
    def test_click_resolution_presets_idempotency_snapshots_and_written_reply(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp)
            store = fixture / "store"
            workspace = fixture / "workspace"
            (workspace / "docs").mkdir(parents=True)
            (workspace / "docs" / "GOALS.md").write_text(
                "## Goal 1. Basics\n"
                "- G1.1 `[~]` Starter verification\n"
                "## Goal 2. Contact\n"
                "- G2.11 `[~]` Contact literature order\n",
                encoding="utf-8",
            )
            web = fixture / "web"
            web.mkdir()
            (web / "index.html").write_text("<title>Mailroom fixture</title>\n", encoding="utf-8")

            env = {k: v for k, v in os.environ.items() if not k.startswith("BUS_")}
            env.update(
                COORD_STORE=str(store),
                BUS_DASHBOARD_DIR=str(web),
                BUS_REPO_DIR=str(workspace),
                PYTHON=sys.executable,
                PYTHONDONTWRITEBYTECODE="1",
            )
            subprocess.check_call([RUN, "init"], env=env, stdout=subprocess.DEVNULL)

            public, admin = _free_port(), _free_port()
            while admin == public:
                admin = _free_port()
            env["BUS_URL"] = f"http://127.0.0.1:{public}"

            def api_call(port: int, path: str, *, post=None) -> tuple[int, dict | list]:
                payload = None if post is None else json.dumps(post).encode("utf-8")
                headers = {"Content-Type": "application/json"} if payload is not None else {}
                req = Request(f"http://127.0.0.1:{port}{path}", data=payload, headers=headers)
                with urlopen(req, timeout=5) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))

            def expect_error(port: int, path: str, post: dict, expected_code: int) -> dict:
                req = Request(
                    f"http://127.0.0.1:{port}{path}",
                    data=json.dumps(post).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                with self.assertRaises(HTTPError) as ctx:
                    urlopen(req, timeout=5)
                self.assertEqual(ctx.exception.code, expected_code)
                return json.loads(ctx.exception.read().decode("utf-8"))

            def client(*args: str):
                out = subprocess.check_output([sys.executable, str(CLIENT), *args], env=env, timeout=8)
                return json.loads(out.decode("utf-8"))

            with (fixture / "server.log").open("w+", encoding="utf-8") as log:
                server = subprocess.Popen(
                    [RUN, "serve", "--port", str(public), "--admin-port", str(admin)],
                    env=env,
                    stdout=log,
                    stderr=log,
                )
                try:
                    for _ in range(100):
                        try:
                            api_call(admin, "/api/todo")
                            break
                        except URLError:
                            if server.poll() is not None:
                                log.seek(0)
                                self.fail(log.read())
                            time.sleep(0.05)
                    else:
                        self.fail("Mailroom server did not start")

                    for aid in ("coordinator", "worker"):
                        api_call(admin, "/api/agents", post={"id": aid, "name": aid.title()})
                    api_call(admin, "/api/links", post={"links": [{"a": "coordinator", "b": "worker"}]})

                    # Start G2.11 and post an open human.needed item (mirrors e8715 / e8728).
                    client("post", "--from", "coordinator", "--to", "worker", "--type", "task.started",
                           "--task-id", "G2.11", "--body", "Start G2.11 audit")
                    hn1 = client(
                        "post",
                        "--from", "coordinator",
                        "--to", "user",
                        "--type", "human.needed",
                        "--task-id", "G2.11",
                        "--subject", "Pick G2.11 implementation order",
                        "--body", "Choose option A, B, or C.",
                    )
                    # Drain coordinator's own inbox before resolving.
                    client("mark-seen", "--agent", "coordinator", "--event-id", hn1["id"])
                    self.assertEqual(client("inbox", "--agent", "coordinator"), [])

                    _, tasks_before = api_call(public, "/api/tasks")
                    g211_before = next(t for t in tasks_before if t["task_id"] == "G2.11")
                    self.assertEqual(g211_before["state"], "waiting_human")
                    _, snap_before = api_call(public, "/api/snapshot")

                    # Validation guards: non-user refused, text body refused, bad/missing target refused, free-text preset refused.
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "worker", "in_reply_to": hn1["id"],
                    }, 403)
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "user", "in_reply_to": hn1["id"], "body": "Typed text",
                    }, 400)
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "user",
                    }, 400)
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "user", "in_reply_to": "e99999",
                    }, 404)
                    normal_msg = client("post", "--from", "coordinator", "--to", "worker",
                                        "--task-id", "G1.1", "--body", "Regular message")
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "user", "in_reply_to": normal_msg["id"],
                    }, 400)
                    expect_error(public, "/api/events", {
                        "type": "human.resolved", "from": "user", "in_reply_to": hn1["id"],
                        "resolved_via": "Answered option A in hallway",
                    }, 400)

                    # Confirm click-resolution with "Muse chat" preset on public port (no text required).
                    code1, res1 = api_call(public, "/api/events", post={
                        "type": "human.resolved",
                        "from": "user",
                        "in_reply_to": hn1["id"],
                        "resolved_via": "Muse chat",
                    })
                    self.assertEqual(code1, 201)
                    assert isinstance(res1, dict)
                    self.assertEqual(res1["type"], "human.resolved")
                    self.assertEqual(res1["from"], "user")
                    self.assertEqual(res1["to"], "coordinator")
                    self.assertEqual(res1["in_reply_to"], hn1["id"])
                    self.assertEqual(res1["task_id"], "G2.11")
                    self.assertEqual(res1["body"], "")
                    self.assertIs(res1["resolved_by_click"], True)
                    self.assertEqual(res1["resolved_via"], "muse_chat")
                    self.assertTrue(res1["ts"].endswith("Z"))

                    # Idempotent repeat click returns 200 with the same event and does not append a duplicate.
                    code_dup, res_dup = api_call(admin, "/api/events", post={
                        "type": "human.resolved",
                        "from": "user",
                        "in_reply_to": hn1["id"],
                        "resolved_via": "terminal",
                    })
                    self.assertEqual(code_dup, 200)
                    self.assertEqual(res_dup, res1)

                    # Incremental and full /api/snapshot reflect the resolution and restore G2.11 task state.
                    inc_qs = (
                        f"/api/snapshot?after={snap_before['last_id']}"
                        f"&cursor={snap_before['event_cursor']}"
                        f"&tasks_after={snap_before['tasks_revision']}"
                    )
                    _, snap_inc = api_call(public, inc_qs)
                    self.assertFalse(snap_inc["full"])
                    self.assertTrue(any(e["id"] == res1["id"] and e["resolved_by_click"] is True for e in snap_inc["events"]))
                    g211_after = next(t for t in snap_inc["tasks"] if t["task_id"] == "G2.11")
                    self.assertEqual(g211_after["state"], "started")

                    # Click-resolution never pollutes coordinator's unread inbox or triggers watch_inbox wakes.
                    self.assertEqual(client("inbox", "--agent", "coordinator"), [])
                    self.assertEqual(snap_inc["presence"]["coordinator"]["unread"], 0)
                    wake = subprocess.check_output(
                        [
                            sys.executable,
                            str(ROOT / "mailroom/bus/watch_inbox.py"),
                            "--agent", "coordinator",
                            "--thread", "session-1",
                            "--codex", "/unused/codex",
                            "--dry-run",
                        ],
                        env=env,
                        timeout=8,
                    )
                    self.assertEqual(wake, b"")

                    # Task discussion & untagged triage skip empty human.resolved events.
                    _, detail_g211 = api_call(admin, "/api/todo?id=G2.11")
                    self.assertNotIn(res1["id"], [e["id"] for e in detail_g211["events"]])

                    # Multi-item task + unset preset + "terminal" + "other" + expired temporary agent sender.
                    hn2 = client("post", "--from", "coordinator", "--to", "user", "--type", "human.needed",
                                 "--task-id", "G1.1", "--body", "Question 1")
                    hn3 = client("post", "--from", "coordinator", "--to", "user", "--type", "human.needed",
                                 "--task-id", "G1.1", "--body", "Question 2")

                    # Resolve hn2 with NO preset selected (unset -> resolved_via is None).
                    code2, res2 = api_call(admin, "/api/events", post={
                        "type": "human.resolved",
                        "from": "user",
                        "in_reply_to": hn2["id"],
                    })
                    self.assertEqual(code2, 201)
                    self.assertIs(res2["resolved_by_click"], True)
                    self.assertIsNone(res2["resolved_via"])
                    # G1.1 still has hn3 open, so derived state remains waiting_human.
                    _, tasks_mid = api_call(public, "/api/tasks")
                    self.assertEqual(next(t for t in tasks_mid if t["task_id"] == "G1.1")["state"], "waiting_human")

                    # Resolve hn3 with "terminal" preset -> G1.1 leaves waiting_human.
                    code3, res3 = api_call(public, "/api/events", post={
                        "type": "human.resolved",
                        "from": "user",
                        "in_reply_to": hn3["id"],
                        "resolved_via": "terminal",
                    })
                    self.assertEqual(code3, 201)
                    self.assertEqual(res3["resolved_via"], "terminal")
                    _, tasks_cleared = api_call(public, "/api/tasks")
                    self.assertEqual(next(t for t in tasks_cleared if t["task_id"] == "G1.1")["state"], "open")

                    # Ended temporary agent's human.needed item can still be marked resolved with "other".
                    agents_path = store / "bus" / "agents.json"
                    agents_data = json.loads(agents_path.read_text(encoding="utf-8"))
                    agents_data["agents"].append({
                        "id": "t1",
                        "name": "Temp Helper",
                        "kind": "temporary",
                        "state": "working",
                    })
                    agents_path.write_text(json.dumps(agents_data, indent=2) + "\n", encoding="utf-8")
                    hn_temp = client("post", "--from", "t1", "--to", "user", "--type", "human.needed",
                                     "--body", "Untagged temp question")
                    agents_data = json.loads(agents_path.read_text(encoding="utf-8"))
                    for a in agents_data["agents"]:
                        if a["id"] == "t1":
                            a["state"] = "expired"
                    agents_path.write_text(json.dumps(agents_data, indent=2) + "\n", encoding="utf-8")

                    code_temp, res_temp = api_call(public, "/api/events", post={
                        "type": "human.resolved",
                        "from": "user",
                        "in_reply_to": hn_temp["id"],
                        "resolved_via": "other",
                    })
                    self.assertEqual(code_temp, 201)
                    self.assertEqual(res_temp["to"], "t1")
                    self.assertEqual(res_temp["resolved_via"], "other")
                    _, untagged = api_call(admin, "/api/todo?id=untagged")
                    self.assertNotIn(res_temp["id"], [e["id"] for e in untagged["events"]])

                    # Normal in-mailroom written reply path works identically as before.
                    hn_written = client("post", "--from", "coordinator", "--to", "user", "--type", "human.needed",
                                        "--task-id", "G2.11", "--body", "Written reply check")
                    code_msg, written_ev = api_call(public, "/api/events", post={
                        "type": "message",
                        "from": "user",
                        "to": "coordinator",
                        "task_id": "G2.11",
                        "in_reply_to": hn_written["id"],
                        "body": "Proceed with option A.",
                    })
                    self.assertEqual(code_msg, 201)
                    self.assertEqual(written_ev["type"], "message")
                    self.assertEqual(written_ev["body"], "Proceed with option A.")
                    self.assertNotIn("resolved_by_click", written_ev)
                    coord_inbox = client("inbox", "--agent", "coordinator")
                    self.assertEqual([m["id"] for m in coord_inbox], [written_ev["id"]])
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()


if __name__ == "__main__":
    unittest.main()
