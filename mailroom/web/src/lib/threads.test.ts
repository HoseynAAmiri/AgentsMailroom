import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, BusEvent } from "./types";
import type * as ThreadsModule from "./threads";

const {
  buildThreads,
  clickResolutions,
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

test("click-resolution closes targeted human.needed without adding a fake message or polluting Sent items", () => {
  const events: BusEvent[] = [
    ev({
      id: "e8715",
      ts: "2026-11-28T12:29:32Z",
      type: "human.needed",
      from: "muse",
      to: "user",
      task_id: "G2.11",
      subject: "G2.11: pick the upstream implementation order",
      body: "Your pick: A) endorsed order, B) Facci first, C) hold.",
    }),
    ev({
      id: "e8729",
      ts: "2026-11-28T15:05:00Z",
      type: "human.resolved",
      from: "user",
      to: "muse",
      task_id: "G2.11",
      in_reply_to: "e8715",
      body: "",
      resolved_by_click: true,
    }),
  ];

  const open = openHumanRequests(events);
  assert.equal(open.length, 0);

  const resolutions = clickResolutions(events);
  assert.deepEqual(resolutions.get("e8715"), {
    eventId: "e8729",
    targetId: "e8715",
    ts: "2026-11-28T15:05:00Z",
    resolved_by_click: true,
  });

  const ms = mailState(undefined);
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, new Set(open.map((e) => e.id)), ms);

  assert.equal(openHumanThreads(threads, ctx).length, 0);
  assert.equal(threads.length, 1);
  // Thread still contains only the real message (no blank fake reply card) and stays out of Sent items.
  assert.deepEqual(threads[0].events.map((e) => e.id), ["e8715"]);
  assert.equal(threadInFolder(threads[0], "sent", ctx), false);
  assert.equal(threadInFolder(threads[0], "inbox", ctx), true);
});

test("click-resolving one of two open human.needed items in a thread leaves the second open until resolved", () => {
  const baseEvents: BusEvent[] = [
    ev({ id: "e4502", type: "human.needed", task_id: "G5.8", subject: "Push G5.8?" }),
    ev({ id: "e4519", type: "human.needed", task_id: "G5.8", subject: "Clear flag?" }),
    ev({
      id: "e4520",
      ts: "2026-11-21T15:40:00Z",
      type: "human.resolved",
      from: "user",
      to: "muse",
      task_id: "G5.8",
      in_reply_to: "e4502",
      body: "",
      resolved_by_click: true,
    }),
  ];

  const openAfterFirst = openHumanRequests(baseEvents);
  assert.deepEqual(openAfterFirst.map((e) => e.id), ["e4519"]);
  const ms = mailState(undefined);
  const threadsAfterFirst = buildThreads(baseEvents, []);
  const ctxAfterFirst = makeCtx(baseEvents, new Set(openAfterFirst.map((e) => e.id)), ms);
  assert.equal(openHumanThreads(threadsAfterFirst, ctxAfterFirst).length, 1);

  const allResolved: BusEvent[] = [
    ...baseEvents,
    ev({
      id: "e4521",
      ts: "2026-11-21T15:41:00Z",
      type: "human.resolved",
      from: "user",
      to: "muse",
      task_id: "G5.8",
      in_reply_to: "e4519",
      body: "",
      resolved_by_click: true,
    }),
  ];
  const openAfterBoth = openHumanRequests(allResolved);
  assert.equal(openAfterBoth.length, 0);
  const ctxAfterBoth = makeCtx(allResolved, new Set(), ms);
  assert.equal(openHumanThreads(buildThreads(allResolved, []), ctxAfterBoth).length, 0);
});

test("normal written USER reply still closes human.needed and appears in conversation and Sent items", () => {
  const events: BusEvent[] = [
    ev({ id: "e300", type: "human.needed", from: "muse", to: "user", task_id: "G2.11", body: "Pick order" }),
    ev({ id: "e301", type: "message", from: "user", to: "muse", task_id: "G2.11", in_reply_to: "e300", body: "Option A." }),
  ];
  const open = openHumanRequests(events);
  assert.equal(open.length, 0);
  assert.equal(clickResolutions(events).size, 0);

  const ms = mailState(undefined);
  const threads = buildThreads(events, []);
  const ctx = makeCtx(events, new Set(), ms);
  assert.equal(openHumanThreads(threads, ctx).length, 0);
  assert.deepEqual(threads[0].events.map((e) => e.id), ["e300", "e301"]);
  assert.equal(threadInFolder(threads[0], "sent", ctx), true);
});
