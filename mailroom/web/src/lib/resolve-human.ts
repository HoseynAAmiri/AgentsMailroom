import type { BusEvent } from "./types";

export interface ResolveDialogState {
  targets: BusEvent[] | null;
  submitting: boolean;
}

export const INITIAL_RESOLVE_DIALOG_STATE: ResolveDialogState = {
  targets: null,
  submitting: false,
};

/** Extract the first non-empty line of text, collapsed to single spaces and truncated to `max` chars. */
export function firstLineSnippet(text: string | null | undefined, max = 140): string {
  const lines = String(text ?? "").split(/\r?\n/);
  const first = (lines.find((line) => line.trim().length > 0) ?? "").replace(/\s+/g, " ").trim();
  return first.length > max ? first.slice(0, max - 1) + "…" : first;
}

/** Short single-line preview for needs-you items: subject if present, otherwise first line of body. */
export function needsPreview(event: Pick<BusEvent, "subject" | "body">, max = 120): string {
  const subj = String(event.subject ?? "").replace(/\s+/g, " ").trim();
  if (subj) return subj.length > max ? subj.slice(0, max - 1) + "…" : subj;
  return firstLineSnippet(event.body, max);
}

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
  resolveOne: (eventId: string) => Promise<BusEvent>,
): Promise<BusEvent[]> {
  const created: BusEvent[] = [];
  for (const target of targets) {
    created.push(await resolveOne(target.id));
  }
  return created;
}
