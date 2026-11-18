#!/usr/bin/env python3
"""Pre-commit guard for the local coordination store.

FAILS the commit when a staged file
  * is larger than 512 KiB and is not listed in .size-allowlist,
  * is raw operational state (bus/, events.jsonl, cursors, sessions, registry, USER state,
    archive, SQLite) or a JSONL file whose lines carry message bodies,
  * is not on the allow-list (fail closed: reviewed exports, Mailroom source, attachments
    listed in review/attachments.allow),
  * has a forbidden name (.env, keys, tokens, SQLite live files, logs),
  * contains secret-like content (private keys, API/GitHub/Slack/AWS/Tailscale keys,
    bearer headers, quoted password/token/secret assignments).
WARNS (does not fail) on personal-data-like content (emails, Tailscale IPs, home paths):
this repository is local-only; scrub before ever adding a remote.
Prints paths and rule names only, never matched text.
"""
import re
import subprocess
import sys
from pathlib import Path

MAX_BYTES = 512 * 1024
# Raw operational state never enters git (a2 review e1978): event log, cursors, sessions,
# registry, USER state, archive; only reviewed exports are tracked.
RAW_STATE = re.compile(r"^(bus/|archive/|todo/[^/]*\.sqlite3)|(^|/)(events\.jsonl|user_state\.json|agents\.json)$"
                       r"|(^|/)\.(seen|polled)/|(^|/)sessions/")
RAW_EVENT_LINE = re.compile(rb'^\{.*"body"\s*:.*"from"\s*:|^\{.*"from"\s*:.*"body"\s*:', re.M)
FORBIDDEN_NAME = re.compile(
    r"(^|/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|sqlite3|db)|[^/]*\.sqlite3-(wal|shm|journal)"
    r"|[^/]*token[^/]*|[^/]*secret[^/]*|[^/]*\.log)$", re.I)
SECRET = [(n, re.compile(p.encode())) for n, p in [
    ("private_key_block", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("github_token", r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    ("openai_anthropic_key", r"\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b"),
    ("slack_token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"),
    ("aws_key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("tailscale_authkey", r"\btskey-[A-Za-z0-9-]{10,}\b"),
    ("bearer_header", r"(?i)authorization:\s*bearer\s+[A-Za-z0-9._-]{16,}"),
    ("assignment_secret", r"(?i)\b(?:api[_-]?key|secret|passw(?:or)?d|token)\b\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"),
]]
PERSONAL = [(n, re.compile(p.encode())) for n, p in [
    ("email", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    ("tailscale_ipv4", r"(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?![\d.])"),
    ("abs_home_path", r"/home/[A-Za-z0-9_.-]+/"),
]]


ALLOW = re.compile(
    r"^(README\.md|\.gitignore|\.size-allowlist|\.githooks/pre-(commit|push)|tools/[a-z_]+\.(py|sh)"
    r"|review/attachments\.allow|exports/events/e\d{5}-e\d{5}\.jsonl|exports/todo/tasks\.safe\.json"
    r"|mailroom/(cutover|rollback)\.sh|mailroom/bus/[a-z_]+\.py"
    r"|mailroom/web/(src/.+\.(ts|tsx|css|mjs|json|svg|md)|[^/]+\.(json|ts|mjs|md)|\.gitignore|public/[^/]+\.svg))$")
SCRATCH_BUILD = re.compile(r"^mailroom/(?:[^/]+/)*\.(?:[^/]+-build\.|tmp_)[^/]*/")
SAFE_TASK_KEYS = {"goals", "tasks", "id", "number", "title", "removed", "goal_id", "position", "state",
                  "owner", "priority", "decision", "revision", "updated"}


def allowed(name, root):
    """Fail closed: only reviewed export paths, the Mailroom source and listed attachments."""
    if SCRATCH_BUILD.match(name):
        return False
    if ALLOW.match(name):
        return True
    if name.startswith("attachments/"):
        lst = root / "review" / "attachments.allow"
        listed = lst.is_file() and name in {l.strip() for l in lst.read_text().splitlines()}
        return listed
    return False


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def main():
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    allow = set()
    if (root / ".size-allowlist").exists():
        allow = {l.strip() for l in (root / ".size-allowlist").read_text().splitlines() if l.strip() and not l.startswith("#")}
    names = [n for n in git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0") if n]
    errors, warnings = [], []
    for name in names:
        if FORBIDDEN_NAME.search(name):
            errors.append((name, "forbidden_filename"))
            continue
        if RAW_STATE.search(name):
            errors.append((name, "raw_operational_state"))
            continue
        if not allowed(name, root):
            errors.append((name, "not_on_allow_list"))
            continue
        blob = git("show", f":{name}")
        if name.endswith(".jsonl") and RAW_EVENT_LINE.search(blob):
            errors.append((name, "raw_event_with_body"))
        if name.startswith("exports/events/") and (b'"subject"' in blob or b'"body"' in blob):
            errors.append((name, "event_export_contains_text"))
        if name == "exports/todo/tasks.safe.json":
            import json as _json
            def keys(o):
                if isinstance(o, dict):
                    for k, v in o.items():
                        yield k
                        yield from keys(v)
                elif isinstance(o, list):
                    for v in o:
                        yield from keys(v)
            extra = set(keys(_json.loads(blob))) - SAFE_TASK_KEYS
            if extra:
                errors.append((name, "task_export_unreviewed_fields"))
        if len(blob) > MAX_BYTES and name not in allow:
            errors.append((name, f"oversize_{len(blob)}_bytes"))
        for rule, rx in SECRET:
            if rx.search(blob):
                errors.append((name, rule))
        for rule, rx in PERSONAL:
            if rx.search(blob):
                warnings.append((name, rule))
    for name, rule in warnings:
        print(f"store pre-commit WARNING {rule}: {name}", file=sys.stderr)
    for name, rule in errors:
        print(f"store pre-commit FAIL {rule}: {name}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
