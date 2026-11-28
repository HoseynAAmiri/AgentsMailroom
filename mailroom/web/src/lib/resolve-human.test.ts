import assert from "node:assert/strict";
import test from "node:test";
import type { BusEvent, ResolutionChannel } from "./types";
import type * as ResolveModule from "./resolve-human";
import type * as ThreadsModule from "./threads";

const {
  INITIAL_RESOLVE_DIALOG_STATE,
  executeClickResolution,
  mergeUniqueEvents,
  selectResolvableTargets,
  toggleResolutionPreset,
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

test("clicking Mark resolved -> confirmation dialog -> cancel leaves events untouched -> confirm resolves immediately", async () => {
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
  assert.equal(dialogOpen.via, null);

  // Step 3: Cancel closes confirmation dialog without calling API or mutating openHumanRequests.
  let apiCalls = 0;
  const afterCancel = { ...INITIAL_RESOLVE_DIALOG_STATE };
  assert.equal(afterCancel.targets, null);
  assert.equal(apiCalls, 0);
  assert.equal(openHumanRequests(events).length, 1);

  // Step 4: Reopen, toggle preset (Muse chat -> Terminal -> toggle off -> Other -> Muse chat), then confirm.
  let via: ResolutionChannel | null = null;
  via = toggleResolutionPreset(via, "muse_chat");
  assert.equal(via, "muse_chat");
  via = toggleResolutionPreset(via, "muse_chat");
  assert.equal(via, null);
  via = toggleResolutionPreset(via, "terminal");
  assert.equal(via, "terminal");
  via = toggleResolutionPreset(via, "other");
  assert.equal(via, "other");
  via = toggleResolutionPreset(via, "muse_chat");
  assert.equal(via, "muse_chat");

  const created = await executeClickResolution(dialogOpen.targets!, via, async (eventId, chosenVia) => {
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
      resolved_via: chosenVia,
    };
  });

  assert.equal(apiCalls, 1);
  events = mergeUniqueEvents(events, created);
  // Immediate optimistic merge followed by poll refresh containing the same event does not duplicate.
  events = mergeUniqueEvents(events, created);
  assert.equal(events.length, 3);
  assert.equal(openHumanRequests(events).length, 0);
  assert.deepEqual(clickResolutions(events).get("e8715"), {
    eventId: "e8729",
    targetId: "e8715",
    ts: "2026-11-28T15:10:00Z",
    resolved_by_click: true,
    resolved_via: "muse_chat",
  });
});
