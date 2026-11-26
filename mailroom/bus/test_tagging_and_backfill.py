"""Tests for G6.1 Mailroom task tagging, validation warnings, doc inference, and scoped backfill."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
BUS_PY = ROOT / "mailroom" / "bus" / "bus.py"
BACKFILL_PY = ROOT / "tools" / "backfill_post_cutover_tags.py"

sys.path.insert(0, str(ROOT / "mailroom" / "bus"))
sys.path.insert(0, str(ROOT / "tools"))

import bus  # noqa: E402
import backfill_post_cutover_tags as backfill  # noqa: E402


def _make_workspace_and_store(root: Path) -> tuple[Path, Path, dict[str, str]]:
    repo = root / "repo"
    docs = repo / "docs"
    (docs / "goals-and-tasks" / "G5" / "g5_8_matched_ca").mkdir(parents=True)
    (docs / "goals-and-tasks" / "G8" / "g8_8_followups").mkdir(parents=True)
    (docs / "goals-and-tasks" / "_templates").mkdir(parents=True)
    (docs / "GOALS.md").write_text(
        "## Goal 5. Validate\n"
        "- G5.8 `[~]` Matched Ca\n"
        "## Goal 8. Remesh\n"
        "- G8.6 `[x]` Legacy G8.6\n"
        "- G8.8 `[~]` Remeshing followups\n",
        encoding="utf-8",
    )
    (docs / "goals-and-tasks" / "G8" / "g8_8_followups" / "context.md").write_text(
        "# G8.8 context without front-matter\n", encoding="utf-8"
    )
    (docs / "goals-and-tasks" / "G5" / "g5_8_matched_ca" / "work_order.md").write_text(
        "# Work order\n", encoding="utf-8"
    )
    (docs / "goals-and-tasks" / "_templates" / "context.md").write_text(
        "# Template\n", encoding="utf-8"
    )

    store = root / "store"
    for sub in ("bus", "attachments", "status", "todo"):
        (store / sub).mkdir(parents=True)
    (store / "bus" / "agents.json").write_text(
        json.dumps(
            {
                "agents": [
                    {"id": "a1", "name": "Claude", "role": "Orchestrator", "machine": "A"},
                    {"id": "a3", "name": "Worker", "role": "Worker", "machine": "A"},
                    {"id": "a6", "name": "Upstream", "role": "PRs", "machine": "A"},
                ],
                "links": [
                    {"a": "a1", "b": "a3"},
                    {"a": "a1", "b": "a6"},
                ],
            }
        ),
        encoding="utf-8",
    )
    (store / "bus" / "events.jsonl").write_text("", encoding="utf-8")
    env = {
        **os.environ,
        "COORD_STORE": str(store),
        "BUS_REPO_DIR": str(repo),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    subprocess.run([sys.executable, str(BUS_PY), "todo", "seed"], env=env, check=True, stdout=subprocess.DEVNULL)
    # Mark G8.6 retired (removed=1) in SQLite to mirror live tracker state.
    with sqlite3.connect(store / "todo" / "tasks.sqlite3") as conn:
        conn.execute("UPDATE tasks SET removed=1 WHERE id='G8.6'")
        conn.execute("UPDATE metadata SET cutover=2, cutover_time=?", ("2026-11-18T12:00:00+00:00",))
        conn.commit()
    return repo, store, env


class G61TaggingAndBackfillTest(unittest.TestCase):
    def test_reply_inheritance_and_non_blocking_warnings_cli(self):
        with tempfile.TemporaryDirectory() as td:
            _, store, env = _make_workspace_and_store(Path(td))
            root_msg = subprocess.run(
                [
                    sys.executable,
                    str(BUS_PY),
                    "post",
                    "--from",
                    "a1",
                    "--to",
                    "a3",
                    "--task-id",
                    "G8.8",
                    "--body",
                    "Root message",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(root_msg.stderr.strip(), "")
            root_ev = json.loads(root_msg.stdout)

            # Reply omitting --task-id inherits parent's active G8.8 silently (exit 0, no warning).
            reply = subprocess.run(
                [
                    sys.executable,
                    str(BUS_PY),
                    "post",
                    "--from",
                    "a3",
                    "--to",
                    "a1",
                    "--in-reply-to",
                    root_ev["id"],
                    "--body",
                    "Reply inheriting task_id",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(reply.stderr.strip(), "")
            reply_ev = json.loads(reply.stdout)
            self.assertEqual(reply_ev["task_id"], "G8.8")

            # Standalone post missing --task-id warns on stderr but still succeeds (exit 0 + valid JSON).
            missing = subprocess.run(
                [
                    sys.executable,
                    str(BUS_PY),
                    "post",
                    "--from",
                    "a1",
                    "--to",
                    "a3",
                    "--body",
                    "Missing tag post",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("no active G#.# task_id", missing.stderr)
            self.assertIsNone(json.loads(missing.stdout)["task_id"])

            # Goal-only tag warns on stderr without refusing.
            goal_only = subprocess.run(
                [
                    sys.executable,
                    str(BUS_PY),
                    "post",
                    "--from",
                    "a1",
                    "--to",
                    "a3",
                    "--task-id",
                    "G8",
                    "--body",
                    "Goal only post",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("not an active G#.#", goal_only.stderr)

            # Retired tag warns on stderr without refusing.
            retired = subprocess.run(
                [
                    sys.executable,
                    str(BUS_PY),
                    "post",
                    "--from",
                    "a1",
                    "--to",
                    "a3",
                    "--task-id",
                    "G8.6",
                    "--body",
                    "Retired tag post",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("retired task_id 'G8.6'", retired.stderr)

            # Offline status is exempt from warning; working status without task_id warns.
            st_off = subprocess.run(
                [sys.executable, str(BUS_PY), "status", "--agent", "a3", "--state", "offline", "--summary", "done"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(st_off.stderr.strip(), "")
            st_work = subprocess.run(
                [sys.executable, str(BUS_PY), "status", "--agent", "a3", "--state", "working", "--summary", "busy"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn("no active G#.# task_id", st_work.stderr)

    def test_front_matter_doc_inference_and_scoped_backfill(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, store, env = _make_workspace_and_store(root)
            cut_ts = datetime.fromisoformat("2026-11-18T12:00:00+00:00").timestamp()

            # Pre-cutover vs post-cutover events in events.jsonl
            events = [
                {"id": "e001", "ts": "2026-11-18T11:00:00Z", "type": "message", "from": "a1", "to": "a3", "task_id": "G8.6", "body": "pre"},
                {"id": "e002", "ts": "2026-11-18T11:30:00Z", "type": "message", "from": "a3", "to": "a1", "in_reply_to": "e001", "task_id": None, "body": "pre reply"},
                {"id": "e003", "ts": "2026-11-18T13:00:00Z", "type": "message", "from": "a1", "to": "a3", "task_id": "G8.6", "body": "post retired"},
                {"id": "e004", "ts": "2026-11-18T13:05:00Z", "type": "message", "from": "a3", "to": "a1", "in_reply_to": "e003", "task_id": "G8", "body": "post reply goal only"},
                {"id": "e005", "ts": "2026-11-18T13:10:00Z", "type": "message", "from": "a6", "to": "a1", "task_id": None, "body": "a6 unmapped",
                 "refs": [{"kind": "file", "value": "coordination/attachments/post_a6.md"}]},
                {"id": "e006", "ts": "2026-11-18T13:15:00Z", "type": "message", "from": "a3", "to": "a1", "in_reply_to": "e004", "task_id": None, "body": "post grandchild",
                 "refs": [{"kind": "file", "value": "coordination/attachments/post_rescued.png"}]},
            ]
            (store / "bus" / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")

            # Attachments with mtimes before/after cutover.
            pre_md = store / "attachments" / "pre_old.md"
            pre_md.write_text("task_id: G8.6\nPre cutover file\n", encoding="utf-8")
            os.utime(pre_md, (cut_ts - 3600, cut_ts - 3600))

            post_bare = store / "attachments" / "post_bare.md"
            post_bare.write_text("task_id: G8.8\nBare header attachment\n", encoding="utf-8")
            os.utime(post_bare, (cut_ts + 3600, cut_ts + 3600))

            post_ret = store / "attachments" / "post_retired.md"
            post_ret.write_text("task_id: G8.6\nPost cutover G8.6 note\n", encoding="utf-8")
            os.utime(post_ret, (cut_ts + 3600, cut_ts + 3600))

            post_rescued = store / "attachments" / "post_rescued.png"
            post_rescued.write_bytes(b"PNG")
            os.utime(post_rescued, (cut_ts + 3600, cut_ts + 3600))

            post_a6 = store / "attachments" / "post_a6.md"
            post_a6.write_text("# Upstream note\n", encoding="utf-8")
            os.utime(post_a6, (cut_ts + 3600, cut_ts + 3600))

            # Verify bare front-matter + todo_documents path inference + _templates skip via bus module subprocess.
            probe = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    "import json, sys; sys.path.insert(0, sys.argv[1]); import bus; "
                    "print(json.dumps({p: t for p, t, _ in bus.todo_documents(0)}))",
                    str(ROOT / "mailroom" / "bus"),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            doc_tags = json.loads(probe.stdout)
            self.assertEqual(doc_tags["coordination/attachments/post_bare.md"], "G8.8")
            self.assertEqual(doc_tags["coordination/attachments/post_retired.md"], "G5.8")
            self.assertEqual(doc_tags["docs/goals-and-tasks/G8/g8_8_followups/context.md"], "G8.8")
            self.assertEqual(doc_tags["docs/goals-and-tasks/G5/g5_8_matched_ca/work_order.md"], "G5.8")
            self.assertFalse(any("_templates" in k for k in doc_tags))

            # Run backfill --dry-run and confirm zero DB writes + exact scoped counts.
            dry = subprocess.run(
                [sys.executable, str(BACKFILL_PY), "--dry-run", "--json"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            dry_json = json.loads(dry.stdout)
            proposed_ids = {row["event_id"]: row["new_task_id"] for row in dry_json["proposed_event_tags"]}
            self.assertEqual(proposed_ids, {"e003": "G5.8", "e004": "G5.8", "e006": "G5.8"})
            self.assertNotIn("e001", proposed_ids)
            self.assertNotIn("e002", proposed_ids)
            self.assertNotIn("e005", proposed_ids)
            self.assertEqual(dry_json["attachment_counts"]["pre_cutover_attachments_untouched"], 1)
            self.assertEqual(dry_json["attachment_counts"]["post_attach_bare_active_resolved_by_item3"], 1)
            self.assertEqual(dry_json["attachment_counts"]["post_attach_rescued_by_event_tag_backfill"], 1)
            self.assertEqual(dry_json["attachment_counts"]["post_attach_retired_g8_6_resolved_by_alias"], 1)

            with sqlite3.connect(store / "todo" / "tasks.sqlite3") as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0], 0)
            self.assertIn("task_id: G8.6", pre_md.read_text(encoding="utf-8"))
            self.assertIn("task_id: G8.6", post_ret.read_text(encoding="utf-8"))

            # Apply SQLite tags only; confirm BOTH pre-cutover and write-once post_retired.md stay untouched on disk.
            subprocess.run(
                [sys.executable, str(BACKFILL_PY), "--apply", "--json"],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            with sqlite3.connect(store / "todo" / "tasks.sqlite3") as conn:
                tags = dict(conn.execute("SELECT event_id, task_id FROM tags"))
            self.assertEqual(tags, {"e003": "G5.8", "e004": "G5.8", "e006": "G5.8"})
            self.assertIn("task_id: G8.6", pre_md.read_text(encoding="utf-8"))
            self.assertIn("task_id: G8.6", post_ret.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
