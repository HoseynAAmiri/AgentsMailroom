#!/usr/bin/env python3
"""Scoped post-cutover task-ID backfill for Mailroom SQLite tags and .md attachments.

Leaves all pre-cutover history (`id <= cutover` or attachment `mtime <= cutover_time`)
untouched. Defaults to `--dry-run` and never modifies files or SQLite unless `--apply`
is passed explicitly.
"""

from __future__ import annotations

import argparse
from bisect import bisect_right
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
MAILROOM_ROOT = TOOLS_DIR.parent
BUS_CODE_DIR = MAILROOM_ROOT / "mailroom" / "bus"
if str(BUS_CODE_DIR) not in sys.path:
    sys.path.insert(0, str(BUS_CODE_DIR))

import bus  # noqa: E402
import todo_store  # noqa: E402

RETIRED_TASK_REMAP = {
    "G8.6": "G5.8",
}
_YAML_FRONT_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)", re.S)
_BARE_TASK_LINE_RE = re.compile(r"^task_id:[ \t]*['\"]?([^\s'\"]+)['\"]?[ \t]*\r?$", re.M)
_RETIRED_OR_GOAL_LINE_RE = re.compile(r"^(task_id:[ \t]*['\"]?)([^\s'\"]+)(['\"]?[ \t]*\r?)$", re.M)


def _load_tracker_snapshot() -> tuple[dict[str, Any], set[str], set[str], dict[str, str]]:
    store = bus.todo_store()
    if not store.initialized():
        raise RuntimeError(f"Tracker DB not found at {store.db}")
    listing = store.listing(include_links=True)
    with closing(store.connect()) as conn:
        rows = conn.execute(
            "SELECT tasks.id, tasks.removed, goals.removed FROM tasks JOIN goals ON goals.id = tasks.goal_id"
        ).fetchall()
        tags = dict(conn.execute("SELECT event_id, task_id FROM tags"))
    active = {r[0] for r in rows if not r[1] and not r[2]}
    retired = {r[0] for r in rows if r[0] not in active}
    return listing, active, retired, tags


def _classify_attachment_front_matter(path: Path) -> tuple[str, str | None]:
    if path.suffix.lower() != ".md":
        return "non_md", None
    try:
        header = path.read_bytes()[:4096].decode("utf-8", errors="replace")
    except OSError:
        return "unreadable", None
    front = _YAML_FRONT_RE.match(header)
    if front:
        m = _BARE_TASK_LINE_RE.search(front[1])
        return ("yaml_front_matter", m[1]) if m else ("none", None)
    lead_lines = []
    for line in header.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            break
        lead_lines.append(line)
        if len(lead_lines) >= 8:
            break
    if lead_lines:
        m = _BARE_TASK_LINE_RE.search("\n".join(lead_lines))
        if m:
            return "bare_front_matter", m[1]
    return "none", None


def compute_plan() -> dict[str, Any]:
    listing, active, retired, existing_tags = _load_tracker_snapshot()
    cutover = int(listing["cutover"])
    cutover_ts = datetime.fromisoformat(listing["cutover_time"]).timestamp()
    active_links = set()
    for t in listing["tasks"]:
        active_links.update(t.get("links") or [])

    events = bus.read_events()
    by_id = {ev.get("id"): ev for ev in events if isinstance(ev.get("id"), str)}
    nums = [bus.id_num(ev.get("id")) for ev in events]
    first_post = bisect_right(nums, cutover)
    pre_events = events[:first_post]
    post_events = events[first_post:]

    # Track effective post-cutover tags cleanly (start with raw + existing SQLite tags).
    effective: dict[str, str | None] = {}
    for ev in events:
        eid = ev.get("id")
        if eid:
            effective[eid] = existing_tags.get(eid) or ev.get("task_id")

    proposed_event_tags: dict[str, dict[str, Any]] = {}
    counts: dict[str, int] = {
        "pre_cutover_events_total": len(pre_events),
        "post_cutover_events_total": len(post_events),
        "post_non_status_total": 0,
        "post_non_status_already_active": 0,
        "post_non_status_untagged_before": 0,
        "post_status_total": 0,
        "post_status_untagged_before": 0,
        "backfill_retired_g8_6_to_g5_8": 0,
        "backfill_reply_inheritance_non_status": 0,
        "backfill_reply_inheritance_status": 0,
        "untouched_retired_other_g1_4": 0,
        "untouched_a6_thread_events": 0,
        "untouched_goal_only_without_active_ancestor": 0,
        "untouched_missing_without_active_ancestor": 0,
    }

    # Pass 1: Retired G8.6 -> G5.8 migration (only for post-cutover events if G5.8 is active).
    if RETIRED_TASK_REMAP["G8.6"] in active:
        for ev in post_events:
            eid = ev.get("id")
            if not eid:
                continue
            cur = effective.get(eid)
            if cur in RETIRED_TASK_REMAP and RETIRED_TASK_REMAP[cur] in active:
                target = RETIRED_TASK_REMAP[cur]
                effective[eid] = target
                proposed_event_tags[eid] = {
                    "event_id": eid,
                    "type": ev.get("type"),
                    "from": ev.get("from"),
                    "old_task_id": cur,
                    "new_task_id": target,
                    "reason": "retired_remap:G8.6->G5.8",
                }
                counts["backfill_retired_g8_6_to_g5_8"] += 1

    # Pass 2: Iterative reply-chain inheritance along in_reply_to (post-cutover events only).
    def find_active_ancestor(ev: dict[str, Any]) -> str | None:
        cur = ev.get("in_reply_to")
        seen: set[str] = set()
        while isinstance(cur, str) and cur and cur not in seen:
            seen.add(cur)
            anc_tag = effective.get(cur)
            if anc_tag in active:
                return anc_tag
            parent = by_id.get(cur)
            cur = parent.get("in_reply_to") if parent else None
        return None

    for ev in post_events:
        eid = ev.get("id")
        if not eid:
            continue
        is_status = ev.get("type") == "agent.status"
        if is_status:
            counts["post_status_total"] += 1
        else:
            counts["post_non_status_total"] += 1
        raw_cur = existing_tags.get(eid) or ev.get("task_id")
        if raw_cur in active:
            if not is_status:
                counts["post_non_status_already_active"] += 1
            continue
        if is_status:
            counts["post_status_untagged_before"] += 1
        else:
            counts["post_non_status_untagged_before"] += 1
        if eid in proposed_event_tags:
            continue
        inherited = find_active_ancestor(ev)
        if inherited:
            effective[eid] = inherited
            proposed_event_tags[eid] = {
                "event_id": eid,
                "type": ev.get("type"),
                "from": ev.get("from"),
                "old_task_id": raw_cur,
                "new_task_id": inherited,
                "reason": "reply_chain_inheritance",
            }
            if is_status:
                counts["backfill_reply_inheritance_status"] += 1
            else:
                counts["backfill_reply_inheritance_non_status"] += 1

    # Check untouched non-status untagged events breakdown & root a6 affiliation.
    def is_a6_thread(ev: dict[str, Any]) -> bool:
        cur: str | None = ev.get("id")
        seen: set[str] = set()
        while cur and cur not in seen:
            seen.add(cur)
            node = by_id.get(cur)
            if not node:
                break
            if node.get("from") == "a6" or node.get("to") == "a6" or "a6" in (node.get("cc") or []):
                return True
            cur = node.get("in_reply_to")
        return False

    remaining_untagged_non_status: list[dict[str, Any]] = []
    for ev in post_events:
        if ev.get("type") == "agent.status":
            continue
        eid = ev.get("id")
        eff = effective.get(eid)
        if eff in active:
            continue
        if eff in retired:
            counts["untouched_retired_other_g1_4"] += 1
        elif is_a6_thread(ev):
            counts["untouched_a6_thread_events"] += 1
        elif isinstance(eff, str) and re.fullmatch(r"G\d+", eff):
            counts["untouched_goal_only_without_active_ancestor"] += 1
        else:
            counts["untouched_missing_without_active_ancestor"] += 1
        remaining_untagged_non_status.append(
            {
                "id": eid,
                "from": ev.get("from"),
                "to": ev.get("to"),
                "old_task_id": eff,
                "in_reply_to": ev.get("in_reply_to"),
                "subject": (ev.get("subject") or "")[:90],
            }
        )

    # Map file refs from ALL post-cutover events (pre-backfill vs post-backfill) cleanly.
    before_event_refs: dict[str, set[str]] = {}
    after_event_refs: dict[str, set[str]] = {}
    for ev in post_events:
        eid = ev.get("id")
        raw_tid = existing_tags.get(eid) or ev.get("task_id")
        eff_tid = effective.get(eid)
        for ref in ev.get("refs") or ():
            if isinstance(ref, dict) and ref.get("kind") in {"file", "path"}:
                val = str(ref.get("value") or "")
                if raw_tid in active:
                    before_event_refs.setdefault(val, set()).add(raw_tid)
                if eff_tid in active:
                    after_event_refs.setdefault(val, set()).add(eff_tid)

    # Scan attachments (including subdirectories via attachments_list) separated by cutover mtime.
    attach_files = sorted(
        (
            p
            for row in bus.attachments_list(limit=5000)
            for p in (bus.ATTACH_DIR / row["name"],)
            if p.is_file()
        ),
        key=lambda p: p.relative_to(bus.ATTACH_DIR).as_posix(),
    )
    pre_attach = [p for p in attach_files if p.stat().st_mtime <= cutover_ts]
    post_attach = [p for p in attach_files if p.stat().st_mtime > cutover_ts]

    attach_counts = {
        "pre_cutover_attachments_untouched": len(pre_attach),
        "post_cutover_attachments_total": len(post_attach),
        "post_attach_yaml_active": 0,
        "post_attach_bare_active_resolved_by_item3": 0,
        "post_attach_retired_g8_6_frontmatter_to_g5_8": 0,
        "post_attach_rescued_by_event_tag_backfill": 0,
        "post_attach_already_covered_by_event_or_link": 0,
        "post_attach_remaining_untagged": 0,
    }
    proposed_attach_frontmatter: list[dict[str, Any]] = []
    remaining_untagged_attach: list[dict[str, Any]] = []

    for p in post_attach:
        rel_attach = p.relative_to(bus.ATTACH_DIR).as_posix()
        label = f"coordination/attachments/{rel_attach}"
        fmt, tag_val = _classify_attachment_front_matter(p)
        if tag_val in active:
            if fmt == "yaml_front_matter":
                attach_counts["post_attach_yaml_active"] += 1
            else:
                attach_counts["post_attach_bare_active_resolved_by_item3"] += 1
            continue
        if tag_val in RETIRED_TASK_REMAP and RETIRED_TASK_REMAP[tag_val] in active:
            target = RETIRED_TASK_REMAP[tag_val]
            attach_counts["post_attach_retired_g8_6_frontmatter_to_g5_8"] += 1
            proposed_attach_frontmatter.append(
                {
                    "path": label,
                    "old_tag": tag_val,
                    "new_tag": target,
                    "format": fmt,
                    "reason": "retired_remap:G8.6->G5.8",
                }
            )
            continue
        if label in before_event_refs or label in active_links:
            attach_counts["post_attach_already_covered_by_event_or_link"] += 1
            continue
        if label in after_event_refs:
            attach_counts["post_attach_rescued_by_event_tag_backfill"] += 1
            continue
        # Check if untagged attachment could only get front-matter if uniquely tied (report only, no guessing).
        attach_counts["post_attach_remaining_untagged"] += 1
        remaining_untagged_attach.append(
            {
                "path": label,
                "front_matter_format": fmt,
                "front_matter_tag": tag_val,
            }
        )

    # Also summarize docs/goals-and-tasks Item (3) coverage on post-cutover docs.
    docs_count = {
        "post_cutover_docs_total": 0,
        "docs_covered_by_path_inference_item3": 0,
        "docs_covered_by_links_or_event": 0,
        "docs_remaining_untagged": 0,
    }
    remaining_untagged_docs: list[str] = []
    for label, doc_tag, mtime in bus.todo_documents(0):
        if label.startswith("coordination/attachments/") or mtime <= cutover_ts:
            continue
        docs_count["post_cutover_docs_total"] += 1
        if doc_tag in active:
            if label in after_event_refs or label in active_links:
                docs_count["docs_covered_by_links_or_event"] += 1
            else:
                docs_count["docs_covered_by_path_inference_item3"] += 1
        elif label in after_event_refs or label in active_links:
            docs_count["docs_covered_by_links_or_event"] += 1
        else:
            docs_count["docs_remaining_untagged"] += 1
            remaining_untagged_docs.append(label)

    return {
        "cutover": {"event_seq": cutover, "timestamp": listing["cutover_time"]},
        "event_counts": counts,
        "attachment_counts": attach_counts,
        "docs_counts": docs_count,
        "proposed_event_tags": list(proposed_event_tags.values()),
        "proposed_attachment_frontmatter_updates": proposed_attach_frontmatter,
        "remaining_untagged_non_status_sample": remaining_untagged_non_status[:25],
        "remaining_untagged_attachments": remaining_untagged_attach,
        "remaining_untagged_docs": remaining_untagged_docs,
    }


def apply_plan(plan: dict[str, Any], *, apply_attachments: bool = False) -> dict[str, Any]:
    store = bus.todo_store()
    rows = [
        (item["event_id"], item["new_task_id"])
        for item in plan["proposed_event_tags"]
    ]
    with closing(store.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.executemany(
            "INSERT INTO tags(event_id, task_id) VALUES (?, ?) "
            "ON CONFLICT(event_id) DO UPDATE SET task_id=excluded.task_id",
            rows,
        )
        conn.execute("UPDATE metadata SET revision=revision+1, updated=? WHERE singleton=1", (todo_store.now(),))
    updated_files = 0
    if apply_attachments:
        for item in plan["proposed_attachment_frontmatter_updates"]:
            rel = item["path"].removeprefix("coordination/attachments/")
            target_file = bus.ATTACH_DIR / rel
            if not target_file.is_file():
                continue
            text = target_file.read_text(encoding="utf-8", errors="replace")
            new_text, n = _RETIRED_OR_GOAL_LINE_RE.subn(
                rf"\g<1>{item['new_tag']}\g<3>", text, count=1
            )
            if n:
                target_file.write_text(new_text, encoding="utf-8")
                updated_files += 1
    return {"sqlite_tags_written": len(rows), "attachment_files_updated": updated_files}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Report planned backfill without modifying files or SQLite (default).")
    mode.add_argument("--apply", action="store_true", help="Write scoped post-cutover SQLite tag overrides.")
    parser.add_argument("--apply-attachments", action="store_true", help="With --apply, also update retired G8.6 front-matter lines in post-cutover .md attachments.")
    parser.add_argument("--json", action="store_true", help="Emit JSON output.")
    args = parser.parse_args(argv)

    plan = compute_plan()
    applied = apply_plan(plan, apply_attachments=args.apply_attachments) if args.apply else None
    if args.json:
        out = {**plan}
        if applied is not None:
            out["applied"] = applied
        print(json.dumps(out, indent=2))
    else:
        ec = plan["event_counts"]
        ac = plan["attachment_counts"]
        dc = plan["docs_counts"]
        print(f"Cutover: > e{plan['cutover']['event_seq']} ({plan['cutover']['timestamp']})")
        print(
            "Events: "
            f"pre_untouched={ec['pre_cutover_events_total']}, "
            f"post_non_status={ec['post_non_status_total']}, "
            f"untagged_before={ec['post_non_status_untagged_before']}, "
            f"proposed_tags={len(plan['proposed_event_tags'])} "
            f"(G8.6->G5.8={ec['backfill_retired_g8_6_to_g5_8']}, "
            f"reply_non_status={ec['backfill_reply_inheritance_non_status']}, "
            f"reply_status={ec['backfill_reply_inheritance_status']})"
        )
        print(
            "Attachments: "
            f"pre_untouched={ac['pre_cutover_attachments_untouched']}, "
            f"post={ac['post_cutover_attachments_total']}, "
            f"bare_item3={ac['post_attach_bare_active_resolved_by_item3']}, "
            f"rescued_by_event={ac['post_attach_rescued_by_event_tag_backfill']}, "
            f"retired_fm_to_g5_8={ac['post_attach_retired_g8_6_frontmatter_to_g5_8']}, "
            f"remaining_untagged={ac['post_attach_remaining_untagged']}"
        )
        print(
            "Docs (non-attachment): "
            f"post={dc['post_cutover_docs_total']}, "
            f"path_inferred_item3={dc['docs_covered_by_path_inference_item3']}, "
            f"links_or_event={dc['docs_covered_by_links_or_event']}, "
            f"remaining_untagged={dc['docs_remaining_untagged']}"
        )
        if applied is not None:
            print(f"Applied: sqlite_tags={applied['sqlite_tags_written']}, files={applied['attachment_files_updated']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
