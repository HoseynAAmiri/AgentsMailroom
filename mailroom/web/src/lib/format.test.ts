import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, BusEvent } from "./types";
import type * as FormatModule from "./format";

const {
  ACTIVE_MIN,
  IDLE_MIN,
  MAX_FUTURE_SKEW_MS,
  buildLastActivityMap,
  effectiveState,
  isFutureOutlier,
  latestActivityTs,
} = (await import(new URL("./format.ts", import.meta.url).href)) as typeof FormatModule;

const NOW = Date.parse("2026-11-19T08:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60000).toISOString();
const msAhead = (ms: number) => new Date(NOW + ms).toISOString();

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    name: "Claude",
    kind: "permanent",
    state: "idle",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    id: "e1",
    ts: minsAgo(1),
    type: "message",
    from: "a1",
    to: "muse",
    body: "ok",
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

test("latestActivityTs uses last_active and latestBusTs only, ignoring updated_at", () => {
  const a = makeAgent({
    last_active: minsAgo(120),
    updated_at: minsAgo(2),
  });
  const recentBus = minsAgo(5);
  assert.equal(latestActivityTs(a, recentBus, NOW), recentBus);
  assert.equal(effectiveState(a, recentBus, NOW), "active");

  const newerLastActive = minsAgo(10);
  const olderBus = minsAgo(45);
  const b = makeAgent({ last_active: newerLastActive, updated_at: minsAgo(1) });
  assert.equal(latestActivityTs(b, olderBus, NOW), newerLastActive);
  assert.equal(effectiveState(b, olderBus, NOW), "active");

  const registeredOnly = makeAgent({ last_active: undefined, updated_at: minsAgo(1) });
  assert.equal(latestActivityTs(registeredOnly, null, NOW), null);
  assert.equal(effectiveState(registeredOnly, null, NOW), "inactive");
});

test("future timestamp outliers beyond MAX_FUTURE_SKEW_MS are ignored while <=5s skew stays active", () => {
  assert.equal(MAX_FUTURE_SKEW_MS, 5_000);
  assert.equal(isFutureOutlier(NOW + 2_000, NOW), false);
  assert.equal(isFutureOutlier(NOW + 5_000, NOW), false);
  assert.equal(isFutureOutlier(NOW + 5_001, NOW), true);

  // +24h future bus event outlier alongside 90m stale valid event -> inactive.
  const staleValidTs = minsAgo(90);
  const outlier24h = msAhead(24 * 60 * 60 * 1000);
  const mapWithStale = buildLastActivityMap(
    [
      makeEvent({ id: "e1", from: "a2", ts: staleValidTs }),
      makeEvent({ id: "e2", from: "a2", ts: outlier24h }),
    ],
    NOW,
  );
  assert.equal(mapWithStale.get("a2"), staleValidTs);
  assert.equal(effectiveState(makeAgent({ id: "a2", last_active: undefined }), mapWithStale.get("a2"), NOW), "inactive");

  // +24h bus outlier alongside 5m valid bus event -> selects 5m event -> active.
  const valid5m = minsAgo(5);
  const mapWithRecent = buildLastActivityMap(
    [
      makeEvent({ id: "e3", from: "a3", ts: outlier24h }),
      makeEvent({ id: "e4", from: "a3", ts: valid5m }),
    ],
    NOW,
  );
  assert.equal(mapWithRecent.get("a3"), valid5m);
  assert.equal(effectiveState(makeAgent({ id: "a3", last_active: minsAgo(120) }), mapWithRecent.get("a3"), NOW), "active");

  // Direct +24h or +60s outlier in last_active or latestBusTs -> ignored -> inactive.
  assert.equal(latestActivityTs(makeAgent({ last_active: outlier24h }), null, NOW), null);
  assert.equal(effectiveState(makeAgent({ last_active: outlier24h }), null, NOW), "inactive");
  const outlier60s = msAhead(60_000);
  assert.equal(latestActivityTs(makeAgent({ last_active: outlier60s }), null, NOW), null);
  assert.equal(effectiveState(makeAgent({ last_active: outlier60s }), null, NOW), "inactive");
  assert.equal(effectiveState(makeAgent({ last_active: undefined }), outlier60s, NOW), "inactive");

  // +2s NTP skew is accepted as active both directly and via buildLastActivityMap.
  const skew2s = msAhead(2_000);
  const mapSkew2s = buildLastActivityMap([makeEvent({ id: "e5", from: "a5", ts: skew2s })], NOW);
  assert.equal(mapSkew2s.get("a5"), skew2s);
  assert.equal(effectiveState(makeAgent({ id: "a5", last_active: skew2s }), null, NOW), "active");
  assert.equal(effectiveState(makeAgent({ id: "a5", last_active: undefined }), mapSkew2s.get("a5"), NOW), "active");
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
