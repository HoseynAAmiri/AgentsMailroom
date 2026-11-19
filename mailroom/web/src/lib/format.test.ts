import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "./types";
import type * as FormatModule from "./format";

const { ACTIVE_MIN, IDLE_MIN, effectiveState, latestActivityTs } = (await import(
  new URL("./format.ts", import.meta.url).href
)) as typeof FormatModule;

const NOW = Date.parse("2026-11-19T08:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    name: "Claude",
    kind: "permanent",
    state: "idle",
    ...overrides,
  };
}

test("thresholds: <15m active, 15..60m idle, >60m or missing inactive", () => {
  assert.equal(ACTIVE_MIN, 15);
  assert.equal(IDLE_MIN, 60);
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(0) }), null, NOW), "active");
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(14.9) }), null, NOW), "active");
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(15) }), null, NOW), "idle");
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(30) }), null, NOW), "idle");
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(60) }), null, NOW), "idle");
  assert.equal(effectiveState(makeAgent({ last_active: minsAgo(60.1) }), null, NOW), "inactive");
  assert.equal(effectiveState(makeAgent({ last_active: undefined, updated_at: undefined }), null, NOW), "inactive");
});

test("regression: a1 with state=idle and recent activity shows active; a3.symg12 4d stale working shows inactive", () => {
  const a1 = makeAgent({
    id: "a1",
    kind: "permanent",
    state: "idle",
    last_active: minsAgo(2),
    updated_at: minsAgo(2),
  });
  assert.equal(effectiveState(a1, null, NOW), "active");

  const staleSub = makeAgent({
    id: "a3.symg12",
    kind: "subagent",
    state: "working",
    last_active: minsAgo(4 * 24 * 60),
    updated_at: minsAgo(4 * 24 * 60),
  });
  assert.equal(effectiveState(staleSub, null, NOW), "inactive");
  // Team page subagent filter excludes inactive without relying on manual `state !== "offline"`.
  const visibleSubs = [staleSub, a1].filter(
    (s) => !s.retired && effectiveState(s, null, NOW) !== "inactive",
  );
  assert.deepEqual(visibleSubs.map((s) => s.id), ["a1"]);
});

test("latestActivityTs picks newest across last_active, latestBusTs, and updated_at", () => {
  const a = makeAgent({
    last_active: minsAgo(120),
    updated_at: minsAgo(180),
  });
  const recentBus = minsAgo(5);
  assert.equal(latestActivityTs(a, recentBus), recentBus);
  assert.equal(effectiveState(a, recentBus, NOW), "active");

  const newerLastActive = minsAgo(10);
  const olderBus = minsAgo(45);
  const b = makeAgent({ last_active: newerLastActive, updated_at: minsAgo(90) });
  assert.equal(latestActivityTs(b, olderBus), newerLastActive);
  assert.equal(effectiveState(b, olderBus, NOW), "active");

  const fallbackOnly = makeAgent({ last_active: undefined, updated_at: minsAgo(25) });
  assert.equal(latestActivityTs(fallbackOnly, null), fallbackOnly.updated_at);
  assert.equal(effectiveState(fallbackOnly, null, NOW), "idle");
});

test("retired and temporary agent lifecycle states stay intact", () => {
  assert.equal(effectiveState(makeAgent({ retired: true, last_active: minsAgo(1) }), minsAgo(1), NOW), "retired");
  for (const life of ["starting", "expired", "stopped", "finished", "failed"] as const) {
    const temp = makeAgent({ id: "t1", kind: "temporary", state: life, last_active: minsAgo(120) });
    assert.equal(effectiveState(temp, null, NOW), life);
  }
  const activeTemp = makeAgent({ id: "t2", kind: "temporary", state: "working", last_active: minsAgo(3) });
  assert.equal(effectiveState(activeTemp, null, NOW), "active");
  const idleTemp = makeAgent({ id: "t3", kind: "temporary", state: "working", last_active: minsAgo(30) });
  assert.equal(effectiveState(idleTemp, null, NOW), "idle");
});
