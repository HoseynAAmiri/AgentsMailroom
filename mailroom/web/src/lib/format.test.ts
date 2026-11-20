import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, BusEvent } from "./types";
import type * as FormatModule from "./format";

const {
  ACTIVE_MIN,
  IDLE_MIN,
  MAX_FUTURE_SKEW_MS,
  PRIORITY_STYLE,
  TASK_STAGES,
  TASK_STAGE_META,
  TASK_STAGE_STYLE,
  applyRoleLabelChange,
  applyRolePresetSelection,
  buildAgentUpsertPayload,
  buildLastActivityMap,
  effectiveState,
  extractTaskDocLinks,
  findMatchingRolePreset,
  groupTasksByStage,
  isFutureOutlier,
  isTaskInProgress,
  isTaskReadyNext,
  latestActivityTs,
  parseTaskStage,
  priorityRank,
  resolveActivityNow,
  resolveTaskFilesFolder,
  sortTasksByPriority,
  summarizeTaskProgress,
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

test("e2506/e2510: snapshot arrival advances shared evaluation clock across events between timer ticks", () => {
  // Stale timer tick (10s or 25s behind wall clock) when fresh snapshot arrives at NOW with a 1s-old event/last_active.
  const tick10sStale = NOW - 10_000;
  const tick25sStale = NOW - 25_000;
  const recvAt = NOW;
  const freshEventTs = new Date(NOW - 1_000).toISOString();
  const freshAgent = makeAgent({ id: "a3", last_active: undefined });
  const ev = makeEvent({ id: "e10", from: "a3", ts: freshEventTs });

  // Under raw stale timer tick alone, a 1s-old event looks +9s / +24s in the future and is wrongly dropped.
  assert.equal(buildLastActivityMap([ev], tick10sStale).get("a3"), undefined);
  assert.equal(effectiveState(freshAgent, freshEventTs, tick10sStale), "inactive");
  assert.equal(effectiveState(freshAgent, freshEventTs, tick25sStale), "inactive");

  // Advancing evaluation clock on snapshot receipt unifies selection and state to active.
  for (const staleTick of [tick10sStale, tick25sStale]) {
    const evalNow = resolveActivityNow(staleTick, recvAt);
    assert.equal(evalNow, recvAt);
    const map = buildLastActivityMap([ev], evalNow);
    assert.equal(map.get("a3"), freshEventTs);
    assert.equal(latestActivityTs(freshAgent, map.get("a3"), evalNow), freshEventTs);
    assert.equal(effectiveState(freshAgent, map.get("a3"), evalNow), "active");
    assert.equal(effectiveState(makeAgent({ id: "a3", last_active: freshEventTs }), null, evalNow), "active");
  }

  // Once timer ticks forward (+20m), resolveActivityNow advances past recvAt so agent transitions to idle.
  const tick20mLater = NOW + 20 * 60_000;
  const laterNow = resolveActivityNow(tick20mLater, recvAt);
  assert.equal(laterNow, tick20mLater);
  assert.equal(effectiveState(freshAgent, buildLastActivityMap([ev], laterNow).get("a3"), laterNow), "idle");

  // True future outliers (+60s, +24h beyond recvAt) remain rejected under resolveActivityNow.
  const outlier60s = msAhead(60_000);
  const outlier24h = msAhead(24 * 60 * 60 * 1000);
  const evalNow = resolveActivityNow(tick10sStale, recvAt);
  const outlierMap = buildLastActivityMap([makeEvent({ id: "e11", from: "a2", ts: outlier24h })], evalNow);
  assert.equal(outlierMap.get("a2"), undefined);
  assert.equal(effectiveState(makeAgent({ id: "a2", last_active: outlier60s }), null, evalNow), "inactive");
});

test("parseTaskStage enforces strict D38 [Stage] tokens without coercing malformed rows", () => {
  assert.deepEqual([...TASK_STAGES], ["Inbox", "Assign", "Stage", "Run", "Review", "Done"]);
  for (const stage of TASK_STAGES) {
    assert.equal(TASK_STAGE_STYLE[stage].label, stage);
    assert.ok(TASK_STAGE_STYLE[stage].cls.length > 0);
    assert.deepEqual(parseTaskStage(`[${stage}] Next step for ${stage}`), {
      stage,
      kind: "valid",
      rawPrefix: stage,
      text: `Next step for ${stage}`,
    });
  }

  // Leading whitespace, stage-only input, and multiline bodies stay valid
  assert.deepEqual(parseTaskStage("  [Review] Wait for a2  "), {
    stage: "Review",
    kind: "valid",
    rawPrefix: "Review",
    text: "Wait for a2",
  });
  assert.deepEqual(parseTaskStage("[Done]"), {
    stage: "Done",
    kind: "valid",
    rawPrefix: "Done",
    text: "",
  });
  assert.deepEqual(parseTaskStage("[Stage] Line 1\nLine 2"), {
    stage: "Stage",
    kind: "valid",
    rawPrefix: "Stage",
    text: "Line 1\nLine 2",
  });

  // Lowercase, padded, unknown, legacy, and empty brackets are flagged malformed (never coerced)
  for (const [raw, prefix] of [
    ["  [review]   Wait for a2  ", "review"],
    ["[ STAGE ] Draft case definition", " STAGE "],
    ["[WIP] draft", "WIP"],
    ["[Result] legacy", "Result"],
    ["[] empty", ""],
  ] as const) {
    assert.deepEqual(parseTaskStage(raw), {
      stage: null,
      kind: "malformed",
      rawPrefix: prefix,
      text: raw.trim(),
    });
  }

  // Plain and empty values are unprefixed
  assert.deepEqual(parseTaskStage("Plain next action"), {
    stage: null,
    kind: "unprefixed",
    rawPrefix: null,
    text: "Plain next action",
  });
  for (const blank of ["   ", "", null, undefined] as const) {
    assert.deepEqual(parseTaskStage(blank), {
      stage: null,
      kind: "unprefixed",
      rawPrefix: null,
      text: "",
    });
  }
});

test("extractTaskDocLinks classifies goal folders, context, dossier, PDF, and multi-report links", () => {
  const full = extractTaskDocLinks([
    "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/context.md",
    "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/dossier.md",
    "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/g1_1_ibamr_examples_and_first_checks.pdf",
    "docs/PLAN.md",
  ], "G1.1");
  assert.deepEqual(full, {
    folder: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks",
    folderLabel: "G1/g1_1_ibamr_examples_and_first_checks",
    context: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/context.md",
    dossier: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/dossier.md",
    pdf: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/g1_1_ibamr_examples_and_first_checks.pdf",
    folders: [
      {
        folder: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks",
        label: "G1/g1_1_ibamr_examples_and_first_checks",
        slug: "g1_1_ibamr_examples_and_first_checks",
        context: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/context.md",
        dossier: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/dossier.md",
        pdf: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/g1_1_ibamr_examples_and_first_checks.pdf",
        extra: [],
      },
    ],
    ownedFolders: [
      {
        folder: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks",
        label: "G1/g1_1_ibamr_examples_and_first_checks",
        slug: "g1_1_ibamr_examples_and_first_checks",
        context: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/context.md",
        dossier: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/dossier.md",
        pdf: "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/g1_1_ibamr_examples_and_first_checks.pdf",
        extra: [],
      },
    ],
    relatedLinks: ["docs/PLAN.md"],
    other: ["docs/PLAN.md"],
  });

  // Canonical G7.13 task folder owns only G7/g7_13_paper_dismantle; cross-links stay in relatedLinks
  const g713 = extractTaskDocLinks([
    "docs/PAPER_PARTS_MAP.md",
    "docs/goals-and-tasks/G1/g1_3_constitutive_and_ibfe_formulation/g1_3_constitutive_and_ibfe_formulation.pdf",
    "docs/goals-and-tasks/G5/g5_1_sideview_coverage_comparison/g5_1_sideview_coverage_comparison.pdf",
    "docs/goals-and-tasks/G7/g7_13_paper_dismantle/context.md",
    "docs/goals-and-tasks/G7/g7_13_paper_dismantle/dossier.md",
    "docs/goals-and-tasks/G7/g7_13_paper_dismantle/g7_13_paper_dismantle.pdf",
  ], "G7.13");
  assert.equal(g713.folderLabel, "G7/g7_13_paper_dismantle");
  assert.equal(g713.context, "docs/goals-and-tasks/G7/g7_13_paper_dismantle/context.md");
  assert.equal(g713.dossier, "docs/goals-and-tasks/G7/g7_13_paper_dismantle/dossier.md");
  assert.equal(g713.pdf, "docs/goals-and-tasks/G7/g7_13_paper_dismantle/g7_13_paper_dismantle.pdf");
  assert.equal(g713.folders.length, 3);
  assert.deepEqual(g713.ownedFolders.map((f) => f.label), ["G7/g7_13_paper_dismantle"]);
  assert.deepEqual(g713.relatedLinks, [
    "docs/PAPER_PARTS_MAP.md",
    "docs/goals-and-tasks/G1/g1_3_constitutive_and_ibfe_formulation/g1_3_constitutive_and_ibfe_formulation.pdf",
    "docs/goals-and-tasks/G5/g5_1_sideview_coverage_comparison/g5_1_sideview_coverage_comparison.pdf",
  ]);
  assert.deepEqual(g713.folders.slice(1).map((f) => f.label), [
    "G1/g1_3_constitutive_and_ibfe_formulation",
    "G5/g5_1_sideview_coverage_comparison",
  ]);
  assert.deepEqual(g713.other, [
    "docs/PAPER_PARTS_MAP.md",
    "docs/goals-and-tasks/G1/g1_3_constitutive_and_ibfe_formulation/g1_3_constitutive_and_ibfe_formulation.pdf",
    "docs/goals-and-tasks/G5/g5_1_sideview_coverage_comparison/g5_1_sideview_coverage_comparison.pdf",
  ]);

  // Multi-report G2.10 prioritizes canonical g2_10 folder while owning all three G2 platen/afm folders
  const g210 = extractTaskDocLinks([
    "docs/goals-and-tasks/G2/g2_10_afm_and_viscoelastic_verification/context.md",
    "docs/goals-and-tasks/G2/g2_10_afm_and_viscoelastic_verification/dossier.md",
    "docs/goals-and-tasks/G2/g2_10_afm_and_viscoelastic_verification/g2_10_afm_and_viscoelastic_verification.pdf",
    "docs/goals-and-tasks/G2/platen_dt_halving/dossier.md",
    "docs/goals-and-tasks/G2/platen_dt_halving/platen_dt_halving.pdf",
    "docs/goals-and-tasks/G2/platen_force/dossier.md",
    "docs/goals-and-tasks/G2/platen_force/platen_force.pdf",
  ], "G2.10");
  assert.equal(g210.folderLabel, "G2/g2_10_afm_and_viscoelastic_verification");
  assert.equal(g210.pdf, "docs/goals-and-tasks/G2/g2_10_afm_and_viscoelastic_verification/g2_10_afm_and_viscoelastic_verification.pdf");
  assert.deepEqual(g210.folders.slice(1).map((f) => f.label), ["G2/platen_dt_halving", "G2/platen_force"]);
  assert.deepEqual(g210.ownedFolders.map((f) => f.label), [
    "G2/g2_10_afm_and_viscoelastic_verification",
    "G2/platen_dt_halving",
    "G2/platen_force",
  ]);
  assert.deepEqual(g210.relatedLinks, []);

  // Multi-report G8.3 owns all 5 G8 folders
  const g83 = extractTaskDocLinks([
    "docs/goals-and-tasks/G8/b1_upstream_start/b1_upstream_start.pdf",
    "docs/goals-and-tasks/G8/b2_bulk_modulus/b2_bulk_modulus.pdf",
    "docs/goals-and-tasks/G8/h01_lc060_refinement/h01_lc060_refinement.pdf",
    "docs/goals-and-tasks/G8/half_drive/half_drive.pdf",
    "docs/goals-and-tasks/G8/half_dt/half_dt.pdf",
  ], "G8.3");
  assert.equal(g83.ownedFolders.length, 5);
  assert.deepEqual(g83.relatedLinks, []);

  // Same-goal cross-link to another numbered task stays in relatedLinks rather than ownedFolders
  const g27 = extractTaskDocLinks([
    "docs/goals-and-tasks/G2/g2_7_symmetric_case_scope/context.md",
    "docs/goals-and-tasks/G2/g2_7_symmetric_case_scope/g2_7_symmetric_case_scope.pdf",
    "docs/goals-and-tasks/G2/g2_3_half_z_symmetry_validation/dossier.md",
  ], "G2.7");
  assert.deepEqual(g27.ownedFolders.map((f) => f.label), ["G2/g2_7_symmetric_case_scope"]);
  assert.deepEqual(g27.relatedLinks, ["docs/goals-and-tasks/G2/g2_3_half_z_symmetry_validation/dossier.md"]);

  // Attachment-only task owns 0 repo folders and surfaces the attachment under relatedLinks
  const g35 = extractTaskDocLinks(["coordination/attachments/2026-11-18_e1959_ridge64_duct64_review/report.md"], "G3.5");
  assert.deepEqual(g35.ownedFolders, []);
  assert.deepEqual(g35.relatedLinks, ["coordination/attachments/2026-11-18_e1959_ridge64_duct64_review/report.md"]);

  // External-only goal link never promotes another task's PDF as primary
  const g713NoOwn = extractTaskDocLinks([
    "docs/goals-and-tasks/G1/g1_3_constitutive_and_ibfe_formulation/g1_3_constitutive_and_ibfe_formulation.pdf",
  ], "G7.13");
  assert.equal(g713NoOwn.folder, null);
  assert.equal(g713NoOwn.pdf, null);
  assert.deepEqual(g713NoOwn.ownedFolders, []);
  assert.deepEqual(g713NoOwn.relatedLinks, [
    "docs/goals-and-tasks/G1/g1_3_constitutive_and_ibfe_formulation/g1_3_constitutive_and_ibfe_formulation.pdf",
  ]);

  const ctxOnly = extractTaskDocLinks(["docs/goals-and-tasks/G6/g6_12_task_logic/context.md"], "G6.12");
  assert.equal(ctxOnly.folderLabel, "G6/g6_12_task_logic");
  assert.equal(ctxOnly.context, "docs/goals-and-tasks/G6/g6_12_task_logic/context.md");
  assert.equal(ctxOnly.dossier, null);
  assert.equal(ctxOnly.pdf, null);
  assert.equal(ctxOnly.folders.length, 1);

  assert.deepEqual(extractTaskDocLinks([]), {
    folder: null,
    folderLabel: null,
    context: null,
    dossier: null,
    pdf: null,
    folders: [],
    ownedFolders: [],
    relatedLinks: [],
    other: [],
  });
});

test("sortTasksByPriority, isTaskReadyNext, and isTaskInProgress separate ready-to-start from active work", () => {
  const sample = [
    { id: "A", priority: "low", state: "todo", decision: 0 },
    { id: "B", priority: "normal", state: "doing", decision: 0 },
    { id: "C", priority: "high", state: "blocked", decision: 1 },
    { id: "D", priority: "normal", state: "done", decision: 0 },
    { id: "E", priority: "high", state: "todo", decision: 0 },
    { id: "F", priority: "low", state: "blocked", decision: 0 },
    { id: "G", priority: "high", state: "doing", decision: 1 },
  ];
  assert.equal(priorityRank("high"), 0);
  assert.equal(priorityRank("normal"), 1);
  assert.equal(priorityRank("low"), 2);
  assert.equal(priorityRank("unexpected"), 1);
  assert.deepEqual(
    sortTasksByPriority(sample).map((t) => t.id),
    ["C", "E", "G", "B", "D", "A", "F"],
  );
  assert.deepEqual(
    sample.filter(isTaskReadyNext).map((t) => t.id),
    ["A", "E"],
  );
  assert.deepEqual(
    sample.filter(isTaskInProgress).map((t) => t.id),
    ["B"],
  );
  assert.equal(PRIORITY_STYLE.high.dotCls.includes("red"), true);
  assert.equal(PRIORITY_STYLE.normal.dotCls.includes("amber"), true);
  assert.equal(PRIORITY_STYLE.low.dotCls.includes("emerald"), true);
  assert.equal(TASK_STAGE_META.Review.shortLabel, "Review");
  assert.equal(TASK_STAGE_META.Done.shortLabel, "Done");
});

test("groupTasksByStage places all 6 canonical stages and preserves malformed/unprefixed rows in unstaged", () => {
  const sample = [
    { id: "T1", next_action: "[Inbox] new" },
    { id: "T2", next_action: "[Assign] scoped" },
    { id: "T3", next_action: "[Stage] manifest" },
    { id: "T4", next_action: "[Run] active" },
    { id: "T5", next_action: "[Review] Line 1\nLine 2" },
    { id: "T6", next_action: "[Done] shipped" },
    { id: "T7", next_action: "[Result] legacy" },
    { id: "T8", next_action: "legacy plain action" },
    { id: "T9", next_action: "[review] lowercase" },
  ];
  const grouped = groupTasksByStage(sample);
  assert.deepEqual(
    grouped.columns.map((c) => [c.stage, c.items.map((x) => x.task.id)]),
    [
      ["Inbox", ["T1"]],
      ["Assign", ["T2"]],
      ["Stage", ["T3"]],
      ["Run", ["T4"]],
      ["Review", ["T5"]],
      ["Done", ["T6"]],
    ],
  );
  assert.deepEqual(
    grouped.unstaged.map((x) => [x.task.id, x.parsed.kind, x.parsed.rawPrefix]),
    [
      ["T7", "malformed", "Result"],
      ["T8", "unprefixed", null],
      ["T9", "malformed", "review"],
    ],
  );
});

test("summarizeTaskProgress counts canonical [Done] completion only", () => {
  const sample = [
    ...Array.from({ length: 18 }, (_, idx) => ({ next_action: `[Done] completed ${idx + 1}` })),
    { next_action: "[Review] awaiting review" },
    ...Array.from({ length: 55 }, (_, idx) => ({ next_action: `[Run] in progress ${idx + 1}` })),
    { next_action: "plain legacy action" },
    { next_action: "[Result] legacy tag should not count as done" },
  ];
  assert.deepEqual(summarizeTaskProgress(sample), {
    total: 76,
    done: 18,
    remaining: 58,
    donePct: 24,
    doneWidthPct: (18 / 76) * 100,
  });
  assert.deepEqual(summarizeTaskProgress([]), {
    total: 0,
    done: 0,
    remaining: 0,
    donePct: 0,
    doneWidthPct: 0,
  });
});

test("resolveTaskFilesFolder picks owned task folder first and falls back to goal folder", () => {
  assert.equal(
    resolveTaskFilesFolder({
      id: "G1.1",
      goal_id: "G1",
      links: [
        "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/context.md",
        "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks/dossier.md",
      ],
    })?.folder,
    "docs/goals-and-tasks/G1/g1_1_ibamr_examples_and_first_checks",
  );
  const unlinked = resolveTaskFilesFolder({ id: "G1.4", goal_id: "G1", links: [] });
  assert.equal(unlinked?.folder, "docs/goals-and-tasks/G1");
  assert.equal(unlinked?.label, "G1");
  assert.equal(
    resolveTaskFilesFolder({
      id: "G8.3",
      goal_id: "G8",
      links: [
        "docs/goals-and-tasks/G8/g8_3_contrast_runs/context.md",
        "docs/goals-and-tasks/G3/g3_11_stiff_baseline/dossier.md",
      ],
    })?.folder,
    "docs/goals-and-tasks/G8/g8_3_contrast_runs",
  );
  assert.equal(resolveTaskFilesFolder({ id: "invalid", goal_id: "", links: [] }), null);
});

test("role preset helpers keep role, role_preset, and role_prompt synchronized", () => {
  const roles = {
    orchestrator: { label: "Orchestrator", prompt: "Plan and delegate." },
    reviewer: { label: "Reviewer", prompt: "Verify and referee." },
    worker: { label: "Worker", prompt: "Build and run." },
  };

  assert.equal(findMatchingRolePreset("Reviewer", roles), "reviewer");
  assert.equal(findMatchingRolePreset("  worker ", roles), "worker");
  assert.equal(findMatchingRolePreset("debate", roles), null);

  // Selecting a preset pill replaces any prior role label (even custom/stale) and updates unedited prompt.
  const fromStale = applyRolePresetSelection(
    { id: "a2", role: "debate", role_preset: "orchestrator", role_prompt: "Plan and delegate." },
    "reviewer",
    roles,
  );
  assert.equal(fromStale.role, "reviewer");
  assert.equal(fromStale.role_preset, "reviewer");
  assert.equal(fromStale.role_prompt, "Verify and referee.");

  // Selecting a preset pill preserves an explicitly customized role prompt.
  const customPromptKept = applyRolePresetSelection(
    { id: "a1", role: "orchestrator", role_preset: "orchestrator", role_prompt: "Custom instruction line." },
    "reviewer",
    roles,
  );
  assert.equal(customPromptKept.role, "reviewer");
  assert.equal(customPromptKept.role_preset, "reviewer");
  assert.equal(customPromptKept.role_prompt, "Custom instruction line.");

  // Typing a preset name in the Role label input syncs role_preset; typing a custom role clears it.
  const typedPreset = applyRoleLabelChange({ id: "a1", role: "orchestrator", role_preset: "orchestrator" }, "Reviewer", roles);
  assert.equal(typedPreset.role_preset, "reviewer");
  const typedCustom = applyRoleLabelChange({ id: "a1", role: "reviewer", role_preset: "reviewer" }, "Custom Lead", roles);
  assert.equal(typedCustom.role_preset, null);
  assert.equal(typedCustom.role, "Custom Lead");

  // Save payload syncs stale role with valid role_preset and normalizes preset-identical prompt to null.
  const staleSynced = buildAgentUpsertPayload(
    { id: " a2 ", name: " Codex ", role: "debate", role_preset: "reviewer", role_prompt: "Verify and referee.", machine: " A " },
    roles,
  );
  assert.equal(staleSynced.id, "a2");
  assert.equal(staleSynced.name, "Codex");
  assert.equal(staleSynced.role, "reviewer");
  assert.equal(staleSynced.role_preset, "reviewer");
  assert.equal(staleSynced.role_prompt, null);

  // Custom role without preset keeps custom role & trimmed custom prompt.
  const customSaved = buildAgentUpsertPayload(
    { id: "a6", role: " Custom Lead ", role_preset: null, role_prompt: "  Special prompt  " },
    roles,
  );
  assert.equal(customSaved.role, "Custom Lead");
  assert.equal(customSaved.role_preset, null);
  assert.equal(customSaved.role_prompt, "Special prompt");
});
