"""Isolation, hook, env-scrubbing, and fail-closed guard tests for tools/snapshot.py."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS_DIR = Path(__file__).resolve().parent
SOURCE_ROOT = TOOLS_DIR.parent
SNAPSHOT_PY = TOOLS_DIR / "snapshot.py"
STORE_PRECOMMIT_PY = TOOLS_DIR / "store_precommit.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_object_and_ref_manifest(dotgit: Path) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for sub in ("objects", "refs"):
        root = dotgit / sub
        if not root.exists():
            continue
        for p in sorted(root.rglob("*")):
            if p.is_file():
                entries.append((p.relative_to(dotgit).as_posix(), sha256(p)))
    packed = dotgit / "packed-refs"
    if packed.is_file():
        entries.append(("packed-refs", sha256(packed)))
    return entries


def write_minimal_store(store: Path, with_source_clone: bool = False) -> Path | None:
    shipped_gitignore = (SOURCE_ROOT / ".gitignore").read_text(encoding="utf-8")
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
    (store / "README.md").write_text("# Source README\n", encoding="utf-8")
    (store / ".size-allowlist").write_text("", encoding="utf-8")
    (store / "mailroom" / "bus").mkdir(parents=True)
    (store / "mailroom" / "bus" / "bus.py").write_text("# bus runtime\n", encoding="utf-8")
    (store / "mailroom" / "run.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (store / "mailroom" / "cutover.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (store / "mailroom" / "rollback.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (store / "mailroom" / "sandbox").mkdir()
    (store / "mailroom" / "sandbox" / "serve.log").write_text("sandbox log\n", encoding="utf-8")

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
        (store / ".gitignore").write_text(shipped_gitignore, encoding="utf-8")
        return None

    # Create a separate upstream bare repo and attach a source clone at store/.git using the EXACT
    # delivered source-only .gitignore from the repository root.
    bare = store.parent / "upstream_origin.git"
    subprocess.run(["git", "init", "--bare", "--initial-branch=dev", str(bare)], check=True, stdout=subprocess.DEVNULL)
    seed = store.parent / "seed_clone"
    subprocess.run(["git", "clone", str(bare), str(seed)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (seed / ".gitignore").write_text(shipped_gitignore, encoding="utf-8")
    (seed / "README.md").write_text("# Source README\n", encoding="utf-8")
    (seed / ".size-allowlist").write_text("", encoding="utf-8")
    (seed / ".githooks").mkdir()
    (seed / ".githooks" / "pre-commit").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    (seed / "tools").mkdir()
    (seed / "tools" / "snapshot.py").write_text(SNAPSHOT_PY.read_text(encoding="utf-8"), encoding="utf-8")
    (seed / "tools" / "store_precommit.py").write_text(
        STORE_PRECOMMIT_PY.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (seed / "mailroom" / "bus").mkdir(parents=True)
    (seed / "mailroom" / "bus" / "bus.py").write_text("# bus runtime\n", encoding="utf-8")
    (seed / "mailroom" / "run.sh").write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(seed), "config", "user.name", "agents-mailroom"], check=True)
    subprocess.run(["git", "-C", str(seed), "config", "user.email", "store@localhost"], check=True)
    subprocess.run(["git", "-C", str(seed), "add", "--all"], check=True)
    subprocess.run(["git", "-C", str(seed), "commit", "-q", "-m", "initial dev commit"], check=True)
    subprocess.run(["git", "-C", str(seed), "push", "-q", "-u", "origin", "HEAD:dev"], check=True)

    # Copy that clean .git metadata and shipped .gitignore into store alongside private state.
    subprocess.run(["cp", "-a", str(seed / ".git"), str(store / ".git")], check=True)
    (store / ".gitignore").write_text(shipped_gitignore, encoding="utf-8")
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

    def test_init_and_coexistence_with_shipped_source_gitignore(self):
        write_minimal_store(self.store, with_source_clone=True)
        (self.store / "attachments" / "unlisted.md").write_text("do not track\n", encoding="utf-8")
        (self.store / "attachments" / "listed.md").write_text("reviewed report\n", encoding="utf-8")
        (self.store / "attachments" / "sym_listed.md").symlink_to(self.store / "attachments" / "listed.md")
        (self.store / "review" / "attachments.allow").write_text(
            "attachments/listed.md\nattachments/sym_listed.md\n", encoding="utf-8"
        )

        # Before snapshot: delivered source .gitignore must keep source status clean across exports,
        # review, attachments, bus, todo, sandbox, and local wrappers.
        src_head_before = subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip()
        src_status_before = subprocess.check_output(["git", "-C", str(self.store), "status", "--short"], text=True)
        self.assertEqual(src_status_before, "", f"unexpected source dirt before snapshot:\n{src_status_before}")
        src_index_sha_before = sha256(self.store / ".git" / "index")
        src_manifest_before = git_object_and_ref_manifest(self.store / ".git")

        r_init = self.run_snap("--git-dir", str(self.git_dir), "--init")
        self.assertIn("initialized isolated snapshot git-dir", r_init.stdout)
        self.assertEqual(
            subprocess.check_output(["git", f"--git-dir={self.git_dir}", "config", "--get", "mailroom.snapshotRepo"], text=True).strip(),
            "true",
        )

        r_snap = self.run_snap("--git-dir", str(self.git_dir))
        self.assertIn("exported 2 event projections", r_snap.stdout)

        # Delivered source .gitignore keeps exports/ and review/ completely ignored in source status
        # even after snapshot exports are generated, and source HEAD/index/objects/refs stay intact.
        self.assertEqual(sha256(self.store / ".git" / "index"), src_index_sha_before)
        self.assertEqual(git_object_and_ref_manifest(self.store / ".git"), src_manifest_before)
        self.assertEqual(
            subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip(),
            src_head_before,
        )
        src_status_after = subprocess.check_output(["git", "-C", str(self.store), "status", "--short"], text=True)
        self.assertEqual(src_status_after, "", f"unexpected source dirt after snapshot:\n{src_status_after}")

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

    def test_inherited_git_env_scrubbed(self):
        write_minimal_store(self.store, with_source_clone=True)
        src_dotgit = self.store / ".git"
        # Refresh source index before capturing invariants.
        self.assertEqual(subprocess.check_output(["git", "-C", str(self.store), "status", "--short"], text=True), "")
        src_head_before = subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip()
        src_index_sha_before = sha256(src_dotgit / "index")
        src_manifest_before = git_object_and_ref_manifest(src_dotgit)

        hostile_env = {
            **self.env,
            "GIT_DIR": str(src_dotgit),
            "GIT_WORK_TREE": str(self.store),
            "GIT_INDEX_FILE": str(src_dotgit / "index"),
            "GIT_COMMON_DIR": str(src_dotgit),
            "GIT_OBJECT_DIRECTORY": str(src_dotgit / "objects"),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(src_dotgit / "objects"),
            "GIT_CONFIG_PARAMETERS": "'core.hooksPath=/tmp/nonexistent-hooks'",
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.excludesFile",
            "GIT_CONFIG_VALUE_0": "/tmp/nonexistent-excludes",
        }
        self.run_snap("--git-dir", str(self.git_dir), "--init", env=hostile_env)
        r_snap = self.run_snap("--git-dir", str(self.git_dir), env=hostile_env)
        self.assertIn("exported 2 event projections", r_snap.stdout)

        # Isolated repo got the commit, while source HEAD, index, objects, and refs remained untouched.
        snap_head = subprocess.check_output(["git", f"--git-dir={self.git_dir}", "rev-parse", "HEAD"], text=True).strip()
        self.assertNotEqual(snap_head, src_head_before)
        self.assertEqual(sha256(src_dotgit / "index"), src_index_sha_before)
        self.assertEqual(git_object_and_ref_manifest(src_dotgit), src_manifest_before)
        self.assertEqual(subprocess.check_output(["git", "-C", str(self.store), "rev-parse", "HEAD"], text=True).strip(), src_head_before)

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

        # 2. Refuses symlinked --git-dir pointing to isolated or source repo.
        sym_gd = self.root / "sym_snapshot.git"
        sym_gd.symlink_to(self.store / ".git")
        self.assertEqual(self.run_snap("--git-dir", str(sym_gd), "--init", check=False).returncode, 2)

        # 3. Refuses gitfile .git target.
        real_src_git = self.root / "external_source_git"
        subprocess.run(["mv", str(self.store / ".git"), str(real_src_git)], check=True)
        (self.store / ".git").write_text(f"gitdir: {real_src_git}\n", encoding="utf-8")
        r_gf = self.run_snap("--git-dir", str(real_src_git), check=False)
        self.assertEqual(r_gf.returncode, 2)
        self.assertIn("overlapping work-tree .git", r_gf.stderr)

        # 4. Refuses unmarked external bare git-dir (no mailroom.snapshotRepo=true).
        unmarked = self.root / "unmarked.git"
        subprocess.run(["git", "init", "--bare", str(unmarked)], check=True, stdout=subprocess.DEVNULL)
        r_unm = self.run_snap("--git-dir", str(unmarked), check=False)
        self.assertEqual(r_unm.returncode, 2)
        self.assertIn("mailroom.snapshotRepo=true", r_unm.stderr)

        # 5. Initialize valid isolated repo, then verify remote, hook, core.worktree, and internal
        # indirection tampering (commondir, objects symlink, alternates, index symlink, missing exclude).
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
        self.assertIn("hooks", r_hp.stderr)
        subprocess.run(["git", f"--git-dir={self.git_dir}", "config", "core.hooksPath", str(self.git_dir / "hooks")], check=True)

        # core.worktree set fails closed.
        subprocess.run(["git", f"--git-dir={self.git_dir}", "config", "core.worktree", str(self.store)], check=True)
        r_wt = self.run_snap("--git-dir", str(self.git_dir), check=False)
        self.assertEqual(r_wt.returncode, 2)
        self.assertIn("core.worktree", r_wt.stderr)
        subprocess.run(["git", f"--git-dir={self.git_dir}", "config", "--unset-all", "core.worktree"], check=True)

        # commondir indirection fails closed.
        (self.git_dir / "commondir").write_text(str(real_src_git) + "\n", encoding="utf-8")
        self.assertEqual(self.run_snap("--git-dir", str(self.git_dir), check=False).returncode, 2)
        (self.git_dir / "commondir").unlink()

        # objects/info/alternates indirection fails closed.
        alt = self.git_dir / "objects" / "info" / "alternates"
        alt.parent.mkdir(parents=True, exist_ok=True)
        alt.write_text(str(real_src_git / "objects") + "\n", encoding="utf-8")
        self.assertEqual(self.run_snap("--git-dir", str(self.git_dir), check=False).returncode, 2)
        alt.unlink()

        # objects symlink indirection fails closed.
        real_objs = self.git_dir / "objects"
        backup_objs = self.root / "backup_objects"
        real_objs.rename(backup_objs)
        real_objs.symlink_to(real_src_git / "objects")
        self.assertEqual(self.run_snap("--git-dir", str(self.git_dir), check=False).returncode, 2)
        real_objs.unlink()
        backup_objs.rename(real_objs)

        # index symlink indirection fails closed.
        (self.git_dir / "index").symlink_to(real_src_git / "index")
        self.assertEqual(self.run_snap("--git-dir", str(self.git_dir), check=False).returncode, 2)
        (self.git_dir / "index").unlink()

        # missing info/exclude fails closed.
        exclude_orig = (self.git_dir / "info" / "exclude").read_text(encoding="utf-8")
        (self.git_dir / "info" / "exclude").unlink()
        self.assertEqual(self.run_snap("--git-dir", str(self.git_dir), check=False).returncode, 2)
        (self.git_dir / "info" / "exclude").write_text(exclude_orig, encoding="utf-8")

        # 6. --migrate-from refuses a source clone that has remotes.
        r_mig = self.run_snap("--git-dir", str(self.root / "mig.git"), "--migrate-from", str(real_src_git), check=False)
        self.assertEqual(r_mig.returncode, 2)
        self.assertIn("remotes", r_mig.stderr)

    def test_unexpected_check_ignore_exit_fails_closed_before_staging(self):
        write_minimal_store(self.store, with_source_clone=True)
        self.run_snap("--git-dir", str(self.git_dir), "--init")

        spec = importlib.util.spec_from_file_location("snapshot_under_test", SNAPSHOT_PY)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        orig_run = subprocess.run
        recorded: list[list[str]] = []

        def wrapped_run(cmd, *args, **kwargs):
            recorded.append(list(cmd))
            if isinstance(cmd, (list, tuple)) and "check-ignore" in cmd:
                return subprocess.CompletedProcess(
                    cmd, returncode=128, stdout=b"", stderr=b"fatal: mock check-ignore error\n"
                )
            return orig_run(cmd, *args, **kwargs)

        with patch.object(mod.subprocess, "run", side_effect=wrapped_run):
            with patch.dict(os.environ, self.env, clear=True):
                rc = mod.main(["--work-tree", str(self.store), "--git-dir", str(self.git_dir)])

        self.assertEqual(rc, 2)
        self.assertFalse(any("add" in cmd for cmd in recorded), f"git add ran after check-ignore failure: {recorded}")

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
