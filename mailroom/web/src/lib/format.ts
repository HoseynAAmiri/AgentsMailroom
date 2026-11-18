import type { Agent, Presence } from "./types";

export function ageMin(ts?: string | null): number {
  if (!ts) return Infinity;
  return (Date.now() - Date.parse(ts)) / 60000;
}

export function ago(ts?: string | null): string {
  const m = ageMin(ts);
  if (!isFinite(m)) return "—";
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 48 * 60) return `${(m / 60).toFixed(1)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/** Outlook-style list time: clock time today, weekday this week, date otherwise. */
export function listTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - d.getTime() < 6 * 86400000) return d.toLocaleDateString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fullTime(ts?: string | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} (${ts.slice(11, 16)} UTC)`;
}

export function countdown(ts?: string | null): string {
  if (!ts) return "";
  const s = Math.round((Date.parse(ts) - Date.now()) / 1000);
  if (s <= 0) return "ended";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}

const PALETTE = [
  "bg-sky-600",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-teal-600",
  "bg-indigo-600",
  "bg-fuchsia-600",
  "bg-lime-700",
  "bg-amber-600",
];
const FIXED: Record<string, string> = { user: "bg-primary", a1: "bg-amber-600", a2: "bg-emerald-600", a3: "bg-violet-600", a5: "bg-sky-600", a4: "bg-zinc-500" };

export function agentColor(id: string): string {
  if (FIXED[id]) return FIXED[id];
  const base = id.split(".")[0];
  if (FIXED[base]) return FIXED[base];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function initials(id: string): string {
  if (id === "user") return "U";
  return id.replace(/^a(?=\d)/, "").slice(0, 3).toUpperCase();
}

export function displayName(id: string | null | undefined, agents: Map<string, Agent>): string {
  if (!id) return "—";
  if (id === "user") return "USER (you)";
  if (id === "*") return "everyone";
  const a = agents.get(id);
  return a && a.name && a.name !== id ? `${a.name} (${id})` : id;
}

export function shortName(id: string, agents: Map<string, Agent>): string {
  if (id === "user") return "You";
  const a = agents.get(id);
  return a && a.name && a.name !== id ? `${id} · ${a.name}` : id;
}

export const STALE_MIN = 45;

export function effectiveState(a: Agent): string {
  if (a.retired) return "retired";
  const last = a.last_active || a.updated_at;
  if (a.state === "working" && ageMin(last) > STALE_MIN) return "stale";
  return a.state || "idle";
}

export const STATE_DOT: Record<string, string> = {
  working: "bg-sky-500",
  starting: "bg-sky-400 animate-pulse",
  waiting: "bg-amber-500",
  stale: "bg-amber-400 ring-1 ring-amber-600/40",
  failed: "bg-red-500",
  idle: "bg-zinc-400",
  offline: "bg-zinc-300 dark:bg-zinc-600",
  retired: "bg-zinc-300 dark:bg-zinc-600",
  expired: "bg-zinc-300 dark:bg-zinc-600",
  stopped: "bg-zinc-300 dark:bg-zinc-600",
  finished: "bg-teal-500",
};

export const TYPE_STYLE: Record<string, { label: string; cls: string }> = {
  message: { label: "message", cls: "bg-muted text-muted-foreground" },
  "task.started": { label: "started", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  "task.blocked": { label: "blocked", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  "task.completed": { label: "completed", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  "task.failed": { label: "failed", cls: "bg-rose-500/15 text-rose-700 dark:text-rose-300" },
  "human.needed": { label: "needs you", cls: "bg-amber-500/20 font-semibold text-amber-800 dark:text-amber-200" },
  "agent.status": { label: "status", cls: "bg-muted text-muted-foreground" },
};

export const TASK_STATE_STYLE: Record<string, { label: string; cls: string }> = {
  open: { label: "tagged", cls: "bg-muted text-muted-foreground" },
  started: { label: "in progress", cls: TYPE_STYLE["task.started"].cls },
  blocked: { label: "blocked", cls: TYPE_STYLE["task.blocked"].cls },
  completed: { label: "done", cls: TYPE_STYLE["task.completed"].cls },
  failed: { label: "failed", cls: TYPE_STYLE["task.failed"].cls },
  waiting_human: { label: "needs you", cls: TYPE_STYLE["human.needed"].cls },
};

export type ConnLevel = "listening" | "watcher" | "backlog" | "quiet" | "offline" | "retired" | "ended";

export interface Connection {
  level: ConnLevel;
  label: string;
  detail: string;
}

/** How reachable an agent is right now, from its inbox checks, watchers and processes. */
export function connection(a: Agent, p: Presence | undefined, hasProcess: boolean, linkOk?: boolean): Connection {
  if (a.retired) return { level: "retired", label: "Retired", detail: "Kept in the registry; not expected to read messages." };
  if (a.kind === "temporary" && ["expired", "stopped", "finished", "failed"].includes(a.state ?? ""))
    return { level: "ended", label: "Ended", detail: `Temporary agent ${a.state}.` };
  const checked = p?.checked_at ? `checked inbox ${ago(p.checked_at)}` : "never checked its inbox";
  const backlog = p?.unread ? `${p.unread} unread, oldest ${ago(p.oldest_unread_ts)}` : "inbox clear";
  if (linkOk === false) return { level: "offline", label: "Link down", detail: `Machine ${a.machine} cannot reach the bus (SSH or tunnel down) · ${checked}` };
  if (p?.listening) return { level: "listening", label: "Listening", detail: `${checked} · ${backlog}` };
  if (p?.watchers.length) {
    const w = p.watchers[0];
    return { level: "watcher", label: "Watcher", detail: `Inbox watcher wakes it${w.last_queued_at ? ` (last wake ${ago(w.last_queued_at)})` : ""} · ${checked} · ${backlog}` };
  }
  if (p?.unread) return { level: "backlog", label: "Not reading", detail: `${backlog} · ${checked}` };
  if (hasProcess || (a.machine && a.machine !== "A")) return { level: "quiet", label: "Quiet", detail: `${checked} · ${backlog}${a.machine && a.machine !== "A" ? ` · via machine ${a.machine} tunnel` : ""}` };
  return { level: "offline", label: "Not connected", detail: `${checked} · no process found on machine A` };
}

export const CONN_STYLE: Record<ConnLevel, string> = {
  listening: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  watcher: "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300",
  backlog: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  quiet: "border-border bg-muted text-muted-foreground",
  offline: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  retired: "border-border bg-muted text-muted-foreground",
  ended: "border-border bg-muted text-muted-foreground",
};

export function gib(bytes?: number | null): string {
  if (!bytes) return "—";
  return `${(bytes / 1073741824).toFixed(2)} GiB`;
}
