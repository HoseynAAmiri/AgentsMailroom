import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { BusEvent } from "./types";
import type * as ResolveModule from "./resolve-human";
import type * as ThreadsModule from "./threads";

const {
  INITIAL_RESOLVE_DIALOG_STATE,
  executeClickResolution,
  firstLineSnippet,
  mergeUniqueEvents,
  needsPreview,
  selectResolvableTargets,
} = (await import(new URL("./resolve-human.ts", import.meta.url).href)) as typeof ResolveModule;

const {
  clickResolutions,
  openHumanRequests,
} = (await import(new URL("./threads.ts", import.meta.url).href)) as typeof ThreadsModule;

function makeEvent(partial: Partial<BusEvent> & { id: string }): BusEvent {
  return {
    ts: "2026-11-28T12:29:32Z",
    type: "message",
    from: "muse",
    to: "user",
    body: "Decision needed",
    ...partial,
  };
}

test("clicking Mark resolved -> confirmation-only dialog -> cancel leaves events untouched -> confirm resolves without channel", async () => {
  let events: BusEvent[] = [
    makeEvent({ id: "e8715", type: "human.needed", task_id: "G2.11", subject: "Pick G2.11 order" }),
    makeEvent({ id: "e8720", type: "message", from: "muse", to: "a3", task_id: "G2.11", body: "Followup" }),
  ];

  // Step 1: Open needs-you detection.
  const initialOpen = openHumanRequests(events);
  const initialOpenIds = new Set(initialOpen.map((e) => e.id));
  assert.deepEqual([...initialOpenIds], ["e8715"]);

  // Step 2: Clicking "Mark resolved" selects only open human.needed items and opens confirmation state.
  const dialogOpen = {
    ...INITIAL_RESOLVE_DIALOG_STATE,
    targets: selectResolvableTargets([events[0], events[0], events[1]], initialOpenIds),
  };
  assert.equal(dialogOpen.targets?.length, 1);
  assert.equal(dialogOpen.targets?.[0].id, "e8715");
  assert.equal("via" in dialogOpen, false);

  // Step 3: Cancel closes confirmation dialog without calling API or mutating openHumanRequests.
  let apiCalls = 0;
  const afterCancel = { ...INITIAL_RESOLVE_DIALOG_STATE };
  assert.equal(afterCancel.targets, null);
  assert.equal(apiCalls, 0);
  assert.equal(openHumanRequests(events).length, 1);

  // Step 4: Confirm sends plain by-click resolution with no channel field.
  const created = await executeClickResolution(dialogOpen.targets!, async (eventId) => {
    apiCalls += 1;
    return {
      id: "e8729",
      ts: "2026-11-28T15:10:00Z",
      type: "human.resolved",
      from: "user",
      to: "muse",
      task_id: "G2.11",
      in_reply_to: eventId,
      body: "",
      refs: [],
      resolved_by_click: true,
    };
  });

  assert.equal(apiCalls, 1);
  events = mergeUniqueEvents(events, created);
  events = mergeUniqueEvents(events, created);
  assert.equal(events.length, 3);
  assert.equal(openHumanRequests(events).length, 0);
  assert.deepEqual(clickResolutions(events).get("e8715"), {
    eventId: "e8729",
    targetId: "e8715",
    ts: "2026-11-28T15:10:00Z",
    resolved_by_click: true,
  });
});

test("needsPreview and firstLineSnippet return compact truncated subject or first line, never full multi-line body", () => {
  const multiLineBody = "\n  First summary line for USER decision.\n\nSecond paragraph with 500 words of detail that must stay hidden until opened.\nThird line.";
  assert.equal(firstLineSnippet(multiLineBody, 120), "First summary line for USER decision.");
  assert.equal(
    needsPreview({ subject: "Approve G6.1 cutover?", body: multiLineBody }, 120),
    "Approve G6.1 cutover?",
  );
  assert.equal(
    needsPreview({ subject: "   ", body: multiLineBody }, 120),
    "First summary line for USER decision.",
  );
  assert.equal(
    needsPreview({ subject: null, body: "A".repeat(40) }, 15),
    `${"A".repeat(14)}…`,
  );
});

test("resolve-dialog and reading-pane keep confirmation-only dialog and truncated needs-you previews", () => {
  const dialogSrc = fs.readFileSync(new URL("../components/mailroom/resolve-dialog.tsx", import.meta.url), "utf8");
  const readingSrc = fs.readFileSync(new URL("../components/mailroom/reading-pane.tsx", import.meta.url), "utf8");
  assert.equal(dialogSrc.includes("Where did you answer"), false);
  assert.equal(dialogSrc.includes("RESOLUTION_PRESETS"), false);
  assert.equal(dialogSrc.includes("Are you sure you answered"), true);
  // Regression guard: never combine `line-clamp-*` with `block` (`display: block` overrides `-webkit-box`)
  // and never auto-expand all openHumanIds inline when opening a thread.
  assert.equal(/line-clamp-\d+\s+block|block\s+line-clamp-\d+/.test(readingSrc), false);
  assert.equal(readingSrc.includes("v.filter((e) => openHumanIds.has(e.id)).forEach((e) => open.add(e.id))"), false);
});
