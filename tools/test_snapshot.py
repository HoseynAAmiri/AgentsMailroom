"""Isolation, hook, and fail-closed guard tests for tools/snapshot.py."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

TOOLS_DIR = Path(__file__).resolve().parent
SNAPSHOT_PY = TOOLS_DIR / "snapshot.py"
STORE_PRECOMMIT_PY = TOOLS_DIR / "store_precommit.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_minimal_store(store: Path, with_source_clone: bool = False) -> Path | None:
    (store / "bus").mkdir(parents=True)
    (store / "attachments").mkdir()
    (store / "review").mkdir()
    (store / "review" / "attachments.allow").write_text("", encoding="utf-8")
    (store / "tools").mkdir()
    (store / "tools" / "snapshot.py").write_text(SNAPSHOT_PY.read_text(encoding="utf-8"), encoding="utf-8")
    (store / "tools" / "store_precommit.py").write_text(
        STORE_PRECOMMIT_PY.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (store / ".githooks").mkdir()
    (store / ".githooks" / "pre-commit").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (store / "README.md").write_text("# Store\n", encoding="utf-8")
    (store / ".size-allowlist").write_text("", encoding="utf-8")
    (store / "mailroom" / "bus").mkdir(parents=True)
    (store / "mailroom" / "bus" / "bus.py").write_text("# bus runtime\n", encoding="utf-8")

    # Seed event log with one normal event and one user-involved event.
    events = [
        {"id": "e00001", "ts": "2026-11-19T00:00:00Z", "type": "message", "from": "coordinator", "to": "worker", "body": "secret body text"},
        {"id": "e00002", "ts": "2026-11-19T00:01:00Z", "type": "human.needed", "from": "coordinator", "to": "user", "body": "sensitive user prompt"},
    ]
    (store / "bus" / "events.jsonl").write_text(
        "\n".join(json.dumps(row) for row in events) + "\n", encoding="utf-8"
    )

    # Seed SQLite goals DB with private notes that must not appear in safe export.
    (store / "todo").mkdir()
    conn = sqlite3.connect(store / "todo" / "tasks.sqlite3")
    conn.executescript(
        """
        create table goals (id text, number integer, title text, removed integer);
        create table tasks (
            id text, goal_id text, number integer, position integer, title text,
            state text, owner text, priority text, decision integer, revision integer,
            updated text, removed integer, notes text
        );
        insert into goals values ('G1', 1, 'Goal One', 0);
        insert into tasks values ('G1.1', 'G1', 1, 1, 'Task One', 'todo', 'worker', 'normal', 0, 1, '2026-11-19T00:00:00Z', 0, 'PRIVATE NOTES');
        """
    )
    conn.commit()
    conn.close()

    if not with_source_clone:
        (store / ".gitignore").write_text("/*\n!/README.md\n", encoding="utf-8")
        return None

    # Create a separate upstream bare repo and attach a source clone at store/.git whose
    # .gitignore explicitly ignores exports/, review/, attachments/, bus/, todo/.
    bare = store.parent / "upstream_origin.git"
    subprocess.run(["git", "init", "--bare", "--initial-branch=dev", str(bare)], check=True, stdout=subprocess.DEVNULL)
    seed = store.parent / "seed_clone"
    subprocess.run(["git", "clone", str(bare), str(seed)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (seed / ".gitignore").write_text(
        "/exports/\n/review/\n/attachments/\n/bus/\n/todo/\n", encoding="utf-8"
    )
    (seed / "README.md").write_text("# Source README\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(seed), "config", "user.name", "agents-mailroom"], check=True)
    subprocess.run(["git", "-C", str(seed), "config", "user.email", "store@localhost"], check=True)
    subprocess.run(["git", "-C", str(seed), "add", ".gitignore", "README.md"], check=True)
    subprocess.run(["git", "-C", str(seed), "commit", "-q", "-m", "initial dev commit"], check=True)
    subprocess.run(["git", "-C", str(seed), "push", "-q", "-u", "origin", "HEAD:dev"], check=True)

    # Copy that clean .git metadata into store/.git alongside the private runtime tree.
    subprocess.run(["cp", "-a", str(seed / ".git"), str(store / ".git")], check=True)
    (store / ".gitignore").write_text("/exports/\n/review/\n/attachments/\n/bus/\n/todo/\n", encoding="utf-8")
    return bare


class SnapshotIsolationTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = self.root / "store"
        self.git_dir = self.root / "isolated" / "snapshot.git"
        self.env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("GIT_", "MAILROOM_SNAPSHOT"))
        }
        self.env["PYTHONDONTWRITEBYTECODE"] = "1"

    def run_snap(self, *args, check: bool = True, env: dict[str, str] | None = None):
        return subprocess.run(
            [sys.executable, str(SNAPSHOT_PY), "--work-tree", str(self.store), *args],
            env=env or self.env,
            capture_output=True,
            text=True,
            timeout=30,
            check=check,
        )

    def test_init_and_coexistence_with_source_clone(self):
        write_minimal_store(self.store, with_source_clone=True)
        (self.store / "attachments" / "unlisted.md").write_text("do not track\n", encoding="utf-8")
        (self.store / "attachments" / "listed.md").write_text("reviewed report\n", encoding="utf-8")
        (self.store / "attachments" / "sym_listed.md").symlink_to(self.store / "attachments" / "listed.md")
        (self.store / "review" / "attachments.allow").write_text(
            "attachments/listed.md\nattachments/sym_listed.md\n", encoding="utf-8"
        )

        src_head_before = subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip()
        src_status_before = subprocess.check_output(["git", "-C", str(self.store), "status", "--short"], text=True)
        src_index_sha_before = sha256(self.store / ".git" / "index")

        r_init = self.run_snap("--git-dir", str(self.git_dir), "--init")
        self.assertIn("initialized isolated snapshot git-dir", r_init.stdout)
        self.assertEqual(
            subprocess.check_output(["git", f"--git-dir={self.git_dir}", "config", "--get", "mailroom.snapshotRepo"], text=True).strip(),
            "true",
        )

        r_snap = self.run_snap("--git-dir", str(self.git_dir))
        self.assertIn("exported 2 event projections", r_snap.stdout)

        # Source clone index, HEAD, and status stay untouched.
        self.assertEqual(sha256(self.store / ".git" / "index"), src_index_sha_before)
        self.assertEqual(
            subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip(),
            src_head_before,
        )
        self.assertEqual(
            subprocess.check_output(["git", "-C", str(self.store), "status", "--short"], text=True),
            src_status_before,
        )

        # Verify tracked files in isolated snapshot GIT_DIR.
        tracked = set(
            subprocess.check_output(
                ["git", f"--git-dir={self.git_dir}", "ls-files"],
                text=True,
                env={**self.env, "GIT_DIR": str(self.git_dir), "GIT_WORK_TREE": str(self.store)},
            ).splitlines()
        )
        self.assertIn("exports/events/e00001-e00500.jsonl", tracked)
        self.assertIn("exports/todo/tasks.safe.json", tracked)
        self.assertIn("review/attachments.allow", tracked)
        self.assertIn("attachments/listed.md", tracked)
        self.assertNotIn("attachments/sym_listed.md", tracked)
        self.assertIn("mailroom/bus/bus.py", tracked)
        self.assertNotIn("bus/events.jsonl", tracked)
        self.assertNotIn("todo/tasks.sqlite3", tracked)
        self.assertNotIn("attachments/unlisted.md", tracked)

        # Projections strip raw bodies and private task notes.
        proj_lines = [json.loads(line) for line in (self.store / "exports" / "events" / "e00001-e00500.jsonl").read_text().splitlines()]
        self.assertNotIn("body", proj_lines[0])
        self.assertEqual(proj_lines[1], {"id": "e00002", "ts": "2026-11-19T00:01:00Z", "type": "human.needed", "user_involved": True})
        safe_tasks = (self.store / "exports" / "todo" / "tasks.safe.json").read_text()
        self.assertNotIn("PRIVATE NOTES", safe_tasks)

        # Repeat snapshot is a clean no-op.
        r_noop = self.run_snap("--git-dir", str(self.git_dir))
        self.assertIn("nothing to snapshot", r_noop.stdout)

        # Push refusal hook blocks pushes even if an explicit bare target is supplied.
        push_target = self.root / "push_target.git"
        subprocess.run(["git", "init", "--bare", str(push_target)], check=True, stdout=subprocess.DEVNULL)
        r_push = subprocess.run(
            ["git", f"--git-dir={self.git_dir}", f"--work-tree={self.store}", "push", str(push_target), "HEAD:main"],
            env={k: v for k, v in self.env.items()},
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(r_push.returncode, 0)
        self.assertIn("push refused", r_push.stderr)

    def test_precommit_blocks_raw_state_unlisted_and_secret_under_isolated_gitdir(self):
        write_minimal_store(self.store, with_source_clone=True)
        self.run_snap("--git-dir", str(self.git_dir), "--init")
        self.run_snap("--git-dir", str(self.git_dir))

        git_env = {
            **self.env,
            "GIT_DIR": str(self.git_dir),
            "GIT_WORK_TREE": str(self.store),
            "GIT_INDEX_FILE": str(self.git_dir / "index"),
        }
        # 1. Raw operational state is blocked by isolated pre-commit hook.
        subprocess.run(["git", "add", "-f", "--", "bus/events.jsonl"], env=git_env, cwd=self.store, check=True)
        r_raw = subprocess.run(["git", "commit", "-m", "bad raw"], env=git_env, cwd=self.store, capture_output=True, text=True)
        self.assertNotEqual(r_raw.returncode, 0)
        self.assertIn("raw_operational_state", r_raw.stderr)
        subprocess.run(["git", "reset", "-q", "HEAD", "--", "bus/events.jsonl"], env=git_env, cwd=self.store, check=True)

        # 2. Unlisted attachment is blocked by isolated pre-commit hook.
        (self.store / "attachments" / "unlisted.md").write_text("blocked\n", encoding="utf-8")
        subprocess.run(["git", "add", "-f", "--", "attachments/unlisted.md"], env=git_env, cwd=self.store, check=True)
        r_unlisted = subprocess.run(["git", "commit", "-m", "bad att"], env=git_env, cwd=self.store, capture_output=True, text=True)
        self.assertNotEqual(r_unlisted.returncode, 0)
        self.assertIn("not_on_allow_list", r_unlisted.stderr)
        subprocess.run(["git", "rm", "-qf", "--cached", "attachments/unlisted.md"], env=git_env, cwd=self.store, check=True)

        # 3. Dynamically generated private key pattern inside allowed mailroom file is blocked.
        key_header = "-----BEGIN " + "RSA PRIVATE KEY-----"
        (self.store / "mailroom" / "bus" / "bad_fixture.py").write_text(f'K = "{key_header}"\n', encoding="utf-8")
        subprocess.run(["git", "add", "-f", "--", "mailroom/bus/bad_fixture.py"], env=git_env, cwd=self.store, check=True)
        r_sec = subprocess.run(["git", "commit", "-m", "bad key fixture"], env=git_env, cwd=self.store, capture_output=True, text=True)
        self.assertNotEqual(r_sec.returncode, 0)
        self.assertIn("private_key_block", r_sec.stderr)

    def test_fail_closed_guards(self):
        bare = write_minimal_store(self.store, with_source_clone=True)
        assert bare is not None

        # 1. Refuses work-tree .git directory directly (even on --init or --dry-run).
        for extra in ((), ("--init",), ("--dry-run",)):
            r = self.run_snap("--git-dir", str(self.store / ".git"), *extra, check=False)
            self.assertEqual(r.returncode, 2)
            self.assertIn("overlapping work-tree .git", r.stderr)

        # 2. Refuses gitfile .git target.
        real_src_git = self.root / "external_source_git"
        subprocess.run(["mv", str(self.store / ".git"), str(real_src_git)], check=True)
        (self.store / ".git").write_text(f"gitdir: {real_src_git}\n", encoding="utf-8")
        r_gf = self.run_snap("--git-dir", str(real_src_git), check=False)
        self.assertEqual(r_gf.returncode, 2)
        self.assertIn("overlapping work-tree .git", r_gf.stderr)

        # 3. Refuses unmarked external bare git-dir (no mailroom.snapshotRepo=true).
        unmarked = self.root / "unmarked.git"
        subprocess.run(["git", "init", "--bare", str(unmarked)], check=True, stdout=subprocess.DEVNULL)
        r_unm = self.run_snap("--git-dir", str(unmarked), check=False)
        self.assertEqual(r_unm.returncode, 2)
        self.assertIn("mailroom.snapshotRepo=true", r_unm.stderr)

        # 4. Initialize valid isolated repo, then verify adding remote/tampering pre-push/hooksPath fails closed.
        self.run_snap("--git-dir", str(self.git_dir), "--init")
        subprocess.run(["git", f"--git-dir={self.git_dir}", "remote", "add", "origin", str(bare)], check=True)
        r_rem = self.run_snap("--git-dir", str(self.git_dir), check=False)
        self.assertEqual(r_rem.returncode, 2)
        self.assertIn("remotes", r_rem.stderr)
        subprocess.run(["git", f"--git-dir={self.git_dir}", "remote", "remove", "origin"], check=True)

        # Tamper pre-push hook, then restore and tamper core.hooksPath.
        pre_push_orig = (self.git_dir / "hooks" / "pre-push").read_text(encoding="utf-8")
        (self.git_dir / "hooks" / "pre-push").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        r_hook = self.run_snap("--git-dir", str(self.git_dir), check=False)
        self.assertEqual(r_hook.returncode, 2)
        self.assertIn("pre-push", r_hook.stderr)
        (self.git_dir / "hooks" / "pre-push").write_text(pre_push_orig, encoding="utf-8")

        subprocess.run(["git", f"--git-dir={self.git_dir}", "config", "core.hooksPath", str(self.store / ".githooks")], check=True)
        r_hp = self.run_snap("--git-dir", str(self.git_dir), check=False)
        self.assertEqual(r_hp.returncode, 2)
        self.assertIn("core.hooksPath", r_hp.stderr)

        # 5. --migrate-from refuses a source clone that has remotes.
        r_mig = self.run_snap("--git-dir", str(self.root / "mig.git"), "--migrate-from", str(real_src_git), check=False)
        self.assertEqual(r_mig.returncode, 2)
        self.assertIn("remotes", r_mig.stderr)

    def test_migrate_from_local_only_preserves_history(self):
        write_minimal_store(self.store, with_source_clone=False)
        subprocess.run(["git", "-C", str(self.store), "init", "--initial-branch=main", "-q"], check=True)
        subprocess.run(["git", "-C", str(self.store), "config", "user.name", "agents-mailroom"], check=True)
        subprocess.run(["git", "-C", str(self.store), "config", "user.email", "store@localhost"], check=True)
        subprocess.run(["git", "-C", str(self.store), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(self.store), "commit", "-q", "-m", "legacy snapshot"], check=True)
        old_head = subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip()

        r_mig = self.run_snap("--git-dir", str(self.git_dir), "--migrate-from", str(self.store / ".git"))
        self.assertIn(old_head[:7], r_mig.stdout)
        self.assertEqual(
            subprocess.check_output(["git", f"--git-dir={self.git_dir}", "rev-parse", "HEAD"], text=True).strip(),
            old_head,
        )
        # Swap out work-tree .git completely, then snapshot cleanly on top of migrated history.
        subprocess.run(["rm", "-rf", str(self.store / ".git")], check=True)
        r_snap = self.run_snap("--git-dir", str(self.git_dir))
        self.assertIn("snapshot ", r_snap.stdout)
        new_parent = subprocess.check_output(["git", f"--git-dir={self.git_dir}", "rev-parse", "HEAD^"], text=True).strip()
        self.assertEqual(new_parent, old_head)


if __name__ == "__main__":
    unittest.main()
