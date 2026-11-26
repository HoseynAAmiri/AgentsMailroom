import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, BusEvent } from "./types";
import type * as ThreadsModule from "./threads";

const {
  buildThreads,
  mailState,
  openHumanRequests,
  openHumanThreads,
  sortFolderThreads,
  threadInFolder,
} = (await import(new URL("./threads.ts", import.meta.url).href)) as typeof ThreadsModule;

function ev(partial: Partial<BusEvent> & { id: string }): BusEvent {
  return {
    ts: "2026-11-21T15:30:00Z",
    type: "message",
    from: "muse",
    to: "user",
    body: "test body",
    ...partial,
  };
}

function makeCtx(
  _events: BusEvent[],
  openHumanIds: Set<string>,
  ms: ThreadsModule.MailState,
): ThreadsModule.FolderCtx {
  const agents = new Map<string, Agent>([
    ["muse", { id: "muse", name: "Muse" }],
    ["a3", { id: "a3", name: "Carbon" }],
  ]);
  return { ms, openHuman: openHumanIds, agents };
}

test("two open human.needed events in one G5.8 thread count as one Needs-you thread", () => {
  const events: BusEvent[] = [
    ev({ id: "e4502", type: "human.needed", task_id: "G5.8", subject: "Push G5.8?" }),
    ev({ id: "e4509", from: "a3", to: "muse", task_id: "G5.8", in_reply_to: "e4502" }),
    ev({ id: "e4519", type: "human.needed", task_id: "G5.8", in_reply_to: "e4509", subject: "Clear flag?" }),
  ];
  const open = openHumanRequests(events);
  const openIds = new Set(open.map((e) => e.id));
  const ms = mailState(undefined);
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, openIds, ms);

  assert.equal(open.length, 2);
  const needsThreads = openHumanThreads(threads, ctx);
  assert.equal(needsThreads.length, 1);
  assert.equal(
    threads.filter((t) => threadInFolder(t, "needs", ctx)).length,
    needsThreads.length,
  );
});

test("task.completed on G5.8 closes both human.needed events and clears Needs-you thread count", () => {
  const events: BusEvent[] = [
    ev({ id: "e4502", type: "human.needed", task_id: "G5.8" }),
    ev({ id: "e4519", type: "human.needed", task_id: "G5.8", in_reply_to: "e4502" }),
    ev({ id: "e4534", type: "task.completed", from: "a3", to: "muse", task_id: "G5.8" }),
  ];
  const open = openHumanRequests(events);
  const openIds = new Set(open.map((e) => e.id));
  const ms = mailState(undefined);
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, openIds, ms);

  assert.equal(open.length, 0);
  assert.equal(openHumanThreads(threads, ctx).length, 0);
});

test("open human.needed events in two distinct threads count as two threads", () => {
  const events: BusEvent[] = [
    ev({ id: "e100", type: "human.needed", task_id: "G5.8" }),
    ev({ id: "e101", type: "human.needed", task_id: "G8.7" }),
  ];
  const open = openHumanRequests(events);
  const openIds = new Set(open.map((e) => e.id));
  const ms = mailState(undefined);
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, openIds, ms);

  assert.equal(open.length, 2);
  assert.equal(openHumanThreads(threads, ctx).length, 2);
});

test("deleted human.needed event in a thread removes that thread from openHumanThreads", () => {
  const events: BusEvent[] = [
    ev({ id: "e200", type: "human.needed", task_id: "G8.7" }),
  ];
  const open = openHumanRequests(events);
  const openIds = new Set(open.map((e) => e.id));
  const ms = mailState({
    read_upto: 0,
    read: [],
    unread: [],
    flagged: [],
    deleted: { e200: "2026-11-21T16:00:00Z" },
  });
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, openIds, ms);

  assert.equal(openHumanThreads(threads, ctx).length, 0);
});

test("pinned threads sort ahead of newer unpinned threads except in Deleted items", () => {
  const events: BusEvent[] = [
    ev({ id: "e1", ts: "2026-11-21T10:00:00Z", task_id: "G1.1", subject: "Old pinned" }),
    ev({ id: "e2", ts: "2026-11-21T12:00:00Z", task_id: "G1.2", subject: "Middle pinned" }),
    ev({ id: "e3", ts: "2026-11-21T15:00:00Z", task_id: "G1.3", subject: "Newest unpinned" }),
  ];
  const threads = buildThreads(events, []);
  const msPinned = mailState({
    read_upto: 0,
    read: [],
    unread: [],
    flagged: [],
    deleted: {},
    pinned: {
      "task:G1.1": "2026-11-21T16:05:00Z",
      "task:G1.2": "2026-11-21T16:01:00Z",
    },
  });

  assert.equal(msPinned.isPinned("task:G1.1"), true);
  assert.equal(msPinned.pinnedAt("task:G1.1"), "2026-11-21T16:05:00Z");
  assert.equal(msPinned.isPinned("task:G1.3"), false);
  assert.equal(msPinned.pinnedAt("task:G1.3"), null);

  for (const folder of ["inbox", "all", "tasks"] as const) {
    assert.deepEqual(
      sortFolderThreads(threads, folder, msPinned).map((t) => t.key),
      ["task:G1.2", "task:G1.1", "task:G1.3"],
    );
  }

  const msDeletedPinned = mailState({
    read_upto: 0,
    read: [],
    unread: [],
    flagged: [],
    deleted: { e1: "2026-11-21T16:00:00Z", e2: "2026-11-21T16:00:00Z", e3: "2026-11-21T16:00:00Z" },
    pinned: {
      "task:G1.1": "2026-11-21T16:05:00Z",
      "task:G1.2": "2026-11-21T16:01:00Z",
    },
  });
  assert.deepEqual(
    sortFolderThreads(threads, "deleted", msDeletedPinned).map((t) => t.key),
    ["task:G1.3", "task:G1.2", "task:G1.1"],
  );

  const msUnpinned = mailState({
    read_upto: 0,
    read: [],
    unread: [],
    flagged: [],
    deleted: {},
    pinned: {},
  });
  assert.deepEqual(
    sortFolderThreads(threads, "all", msUnpinned).map((t) => t.key),
    ["task:G1.3", "task:G1.2", "task:G1.1"],
  );
});
