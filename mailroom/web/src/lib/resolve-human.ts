import type { BusEvent, ResolutionChannel } from "./types";

export interface ResolveDialogState {
  targets: BusEvent[] | null;
  via: ResolutionChannel | null;
  submitting: boolean;
}

export const INITIAL_RESOLVE_DIALOG_STATE: ResolveDialogState = {
  targets: null,
  via: null,
  submitting: false,
};

/** Deduplicate and keep only open `human.needed` items for confirmation. */
export function selectResolvableTargets(candidates: readonly BusEvent[], openHumanIds: ReadonlySet<string>): BusEvent[] {
  const seen = new Set<string>();
  const out: BusEvent[] = [];
  for (const ev of candidates) {
    if (ev.type !== "human.needed" || !openHumanIds.has(ev.id) || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}

/** Toggle an optional resolution channel preset; clicking the active preset clears it back to null. */
export function toggleResolutionPreset(
  current: ResolutionChannel | null,
  chosen: ResolutionChannel,
): ResolutionChannel | null {
  return current === chosen ? null : chosen;
}

/** Merge newly created events into an existing chronological list without duplicates. */
export function mergeUniqueEvents(existing: readonly BusEvent[], incoming: readonly BusEvent[]): BusEvent[] {
  if (!incoming.length) return [...existing];
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  return fresh.length ? [...existing, ...fresh] : [...existing];
}

/** Run the confirmation dialog submit step across all selected open `human.needed` items. */
export async function executeClickResolution(
  targets: readonly BusEvent[],
  via: ResolutionChannel | null,
  resolveOne: (eventId: string, via: ResolutionChannel | null) => Promise<BusEvent>,
): Promise<BusEvent[]> {
  const created: BusEvent[] = [];
  for (const target of targets) {
    created.push(await resolveOne(target.id, via));
  }
  return created;
}
