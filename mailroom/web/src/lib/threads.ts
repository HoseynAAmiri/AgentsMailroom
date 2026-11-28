import type { Agent, BusEvent, ClickResolution, MailTask, MailTaskIndex, Task, UserState } from "./types";

export function idNum(id: string | null | undefined): number {
  const m = String(id ?? "").match(/^e(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

export interface Thread {
  key: string;
  subject: string;
  taskId: string | null;
  events: BusEvent[]; // chronological, includes deleted ones
  participants: string[];
  task: Task | null;
  goalTask: MailTask | null;
}

export interface MailState {
  isDeleted: (e: BusEvent) => boolean;
  isArchived: (e: BusEvent) => boolean;
  isUnread: (e: BusEvent) => boolean;
  isFlagged: (e: BusEvent) => boolean;
  isPinned: (threadKey: string) => boolean;
  pinnedAt: (threadKey: string) => string | null;
}

export function mailState(us: UserState | undefined): MailState {
  const read = new Set(us?.read ?? []);
  const unread = new Set(us?.unread ?? []);
  const flagged = new Set(us?.flagged ?? []);
  const deleted = us?.deleted ?? {};
  const archived = us?.archived ?? {};
  const pinned = us?.pinned ?? {};
  const upto = us?.read_upto ?? 0;
  return {
    isDeleted: (e) => e.id in deleted,
    isArchived: (e) => e.id in archived,
    isUnread: (e) => e.from !== "user" && !(e.id in deleted) && (unread.has(e.id) || (idNum(e.id) > upto && !read.has(e.id))),
    isFlagged: (e) => flagged.has(e.id),
    isPinned: (threadKey) => Object.hasOwn(pinned, threadKey),
    pinnedAt: (threadKey) => (Object.hasOwn(pinned, threadKey) ? pinned[threadKey] : null),
  };
}

export function snippet(s: string | null | undefined, n: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

export function eventTaskId(event: BusEvent, tags?: MailTaskIndex["tags"]) {
  return tags && Object.hasOwn(tags, event.id) ? tags[event.id] : event.task_id ?? null;
}

export function isClickResolutionEvent(event: BusEvent): boolean {
  return event.type === "human.resolved" || event.resolved_by_click === true;
}

export function clickResolutions(events: readonly BusEvent[]): Map<string, ClickResolution> {
  const map = new Map<string, ClickResolution>();
  for (const e of events) {
    if (!isClickResolutionEvent(e) || !e.in_reply_to) continue;
    if (!map.has(e.in_reply_to)) {
      map.set(e.in_reply_to, {
        eventId: e.id,
        targetId: e.in_reply_to,
        ts: e.ts,
        resolved_by_click: true,
        resolved_via: e.resolved_via ?? null,
      });
    }
  }
  return map;
}

export function buildThreads(events: BusEvent[], tasks: Task[], index?: MailTaskIndex): Thread[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const keyOf = new Map<string, string>();
  const resolve = (e: BusEvent, depth = 0): string => {
    const known = keyOf.get(e.id);
    if (known) return known;
    let k: string;
    const taskId = eventTaskId(e, index?.tags);
    if (taskId) k = `task:${taskId}`;
    else if (index?.tags && Object.hasOwn(index.tags, e.id)) k = `ev:${e.id}`;
    else if (e.in_reply_to && byId.has(e.in_reply_to) && depth < 50) k = resolve(byId.get(e.in_reply_to)!, depth + 1);
    else k = `ev:${e.id}`;
    keyOf.set(e.id, k);
    return k;
  };
  const taskMap = new Map(tasks.map((t) => [t.task_id, t]));
  const goalTaskMap = new Map(index?.tasks.map((task) => [task.id, task]));
  const threads = new Map<string, Thread>();
  for (const e of events) {
    if (e.type === "agent.status" || isClickResolutionEvent(e)) continue;
    const k = resolve(e);
    let t = threads.get(k);
    if (!t) {
      t = { key: k, subject: "", taskId: k.startsWith("task:") ? k.slice(5) : null, events: [], participants: [], task: null, goalTask: null };
      threads.set(k, t);
    }
    t.events.push(e);
  }
  for (const t of threads.values()) {
    const ppl = new Set<string>();
    for (const e of t.events) {
      ppl.add(e.from);
      if (e.to && e.to !== "*") ppl.add(e.to);
      (e.cc ?? []).forEach((c) => ppl.add(c));
    }
    t.participants = [...ppl];
    t.task = t.taskId ? taskMap.get(t.taskId) ?? null : null;
    t.goalTask = t.taskId ? goalTaskMap.get(t.taskId) ?? null : null;
    const withSubject = t.events.find((e) => e.subject);
    t.subject = withSubject?.subject || t.taskId || snippet(t.events[0]?.body, 80) || "(no subject)";
  }
  return [...threads.values()];
}

/** human.needed events with no USER answer, click-resolution, or completion afterwards. */
export function openHumanRequests(events: BusEvent[]): BusEvent[] {
  const open: BusEvent[] = [];
  events.forEach((e, i) => {
    if (e.type !== "human.needed") return;
    const later = events.slice(i + 1);
    const closed = later.some((x) => {
      if (isClickResolutionEvent(x)) {
        return x.in_reply_to
          ? x.in_reply_to === e.id
          : Boolean((e.task_id && x.task_id === e.task_id) || x.to === e.from);
      }
      return (
        (x.from === "user" && ((e.task_id && x.task_id === e.task_id) || x.to === e.from || x.in_reply_to === e.id)) ||
        (e.task_id && x.task_id === e.task_id && x.type === "task.completed")
      );
    });
    if (!closed) open.push(e);
  });
  return open;
}

export type FolderId =
  | "inbox"
  | "needs"
  | "flagged"
  | "sent"
  | "all"
  | "tasks"
  | "status"
  | "archive"
  | "deleted"
  | `agent:${string}`;

export interface FolderCtx {
  ms: MailState;
  openHuman: Set<string>;
  agents: ReadonlyMap<string, Agent>;
}

export function threadInFolder(t: Thread, folder: FolderId, ctx: FolderCtx): boolean {
  const { ms } = ctx;
  if (folder === "deleted") return t.events.some(ms.isDeleted);
  const live = t.events.filter((e) => !ms.isDeleted(e));
  if (!live.length) return false;
  const archived = live.every(ms.isArchived);
  if (folder === "archive") return archived;
  if (archived && folder !== "tasks" && folder !== "needs" && folder !== "flagged") return false;
  switch (folder) {
    case "inbox":
      return live.some((e) => e.to === "user" || (e.cc ?? []).includes("user"));
    case "needs":
      return live.some((e) => ctx.openHuman.has(e.id));
    case "flagged":
      return live.some(ms.isFlagged);
    case "sent":
      return live.some((e) => e.from === "user");
    case "all": {
      // Keep failed launch briefs in Sent and the agent's history without cluttering All conversations.
      const agent = ctx.agents.get(live[0].to);
      const failedBrief = t.events.length === 1 && live[0].from === "user" && !live[0].in_reply_to
        && agent?.kind === "temporary" && agent.state === "failed";
      return !failedBrief;
    }
    case "tasks":
      return !!t.taskId;
    default:
      if (folder.startsWith("agent:")) {
        const id = folder.slice(6);
        return live.some((e) => e.from === id || e.to === id || (e.cc ?? []).includes(id));
      }
      return false;
  }
}

/** Threads that appear in the "Needs you" folder (respecting deleted messages). */
export function openHumanThreads(threads: readonly Thread[], ctx: FolderCtx): Thread[] {
  return threads.filter((t) => threadInFolder(t, "needs", ctx));
}

export function visibleEvents(t: Thread, folder: FolderId, ms: MailState): BusEvent[] {
  return folder === "deleted" ? t.events.filter(ms.isDeleted) : t.events.filter((e) => !ms.isDeleted(e));
}

export function lastTs(t: Thread, folder: FolderId, ms: MailState): string {
  const v = visibleEvents(t, folder, ms);
  return v.length ? v[v.length - 1].ts : "";
}

export function sortFolderThreads(list: readonly Thread[], folder: FolderId, ms: MailState): Thread[] {
  return list
    .map((t) => ({
      t,
      ts: lastTs(t, folder, ms),
      pin: folder === "deleted" ? null : ms.pinnedAt(t.key),
    }))
    .sort((a, b) => {
      if ((a.pin !== null) !== (b.pin !== null)) return a.pin !== null ? -1 : 1;
      if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
      if (a.pin !== b.pin) return (a.pin ?? "") < (b.pin ?? "") ? 1 : -1;
      return 0;
    })
    .map((x) => x.t);
}

/** Messages whose id or body contains the keyword, in conversation order. */
export function messageHits(events: readonly BusEvent[], q: string): BusEvent[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return events.filter((e) => e.id.toLowerCase() === needle || e.body.toLowerCase().includes(needle));
}

/** Excerpt centered on the keyword so a list row shows the hit, not the start of the message. */
export function matchSnippet(body: string, q: string, n = 180): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const needle = q.trim().toLowerCase();
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return snippet(flat, n);
  const start = Math.max(0, at - 48);
  const end = Math.min(flat.length, Math.max(start + n, at + needle.length + 48));
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function threadMatches(t: Thread, q: string, agents: Map<string, Agent>): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (t.subject.toLowerCase().includes(needle) || t.goalTask?.title.toLowerCase().includes(needle) || (t.taskId ?? "").toLowerCase().includes(needle)) return true;
  if (t.participants.some((p) => p.toLowerCase() === needle || (agents.get(p)?.name ?? "").toLowerCase().includes(needle))) return true;
  return t.events.some((e) => e.id === needle || e.body.toLowerCase().includes(needle));
}

export const TASK_FILTERS: { key: string; label: string; match: (t: Thread) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "todo", label: "To do", match: (t) => t.goalTask?.state === "todo" },
  { key: "doing", label: "In progress", match: (t) => t.goalTask?.state === "doing" },
  { key: "blocked", label: "Blocked", match: (t) => t.goalTask?.state === "blocked" },
  { key: "done", label: "Done", match: (t) => t.goalTask?.state === "done" },
  { key: "decisions", label: "USER decisions", match: (t) => !!t.goalTask?.decision },
  { key: "unlinked", label: "Unlinked tags", match: (t) => !t.goalTask },
];
