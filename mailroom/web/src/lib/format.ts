import type { Agent, MailTask, Presence } from "./types";

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

const FIXED: Record<string, string> = {
  user: "bg-primary",
  muse: "bg-blue-700",
  a1: "bg-amber-600",
  a2: "bg-emerald-600",
  a3: "bg-violet-600",
  a4: "bg-zinc-500",
  a5: "bg-sky-600",
};

const COLOR_FAMILIES = [
  ["Red", 20],
  ["Orange", 45],
  ["Ochre", 72],
  ["Olive", 100],
  ["Lime", 130],
  ["Green", 158],
  ["Teal", 184],
  ["Cyan", 211],
  ["Blue", 240],
  ["Indigo", 267],
  ["Violet", 294],
  ["Rose", 330],
] as const;

export const AVATAR_COLORS = COLOR_FAMILIES.flatMap(([family, hue]) =>
  Array.from({ length: 10 }, (_, index) => {
    const shadeHue = hue + (index % 5 - 2) * 5;
    const lightness = index < 5 ? 0.51 : 0.55;
    const chroma = shadeHue >= 150 && shadeHue <= 225 ? 0.085 : 0.12;
    return {
      id: `${family.toLowerCase()}-${index + 1}`,
      label: `${family} ${index + 1}`,
      value: `oklch(${lightness} ${chroma} ${shadeHue})`,
    };
  }),
);

const AVATAR_COLOR_VALUES = new Map(AVATAR_COLORS.map(({ id, value }) => [id, value]));

export function avatarColorValue(id: string | undefined) {
  return id ? AVATAR_COLOR_VALUES.get(id) : undefined;
}

export function defaultAvatarClass(id: string) {
  const base = id.split(".")[0];
  return Object.hasOwn(FIXED, base) ? FIXED[base] : undefined;
}

export function avatarColorId(id: string, selected?: string) {
  if (avatarColorValue(selected)) return selected;
  if (defaultAvatarClass(id)) return undefined;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length].id;
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

export const ACTIVE_MIN = 15;
export const IDLE_MIN = 60;
export const TEMP_LIFECYCLE_STATES = ["starting", "expired", "stopped", "finished", "failed"] as const;

export function latestActivityTs(a: Agent, latestBusTs?: string | null): string | null {
  let bestTs: string | null = null;
  let bestMs = -Infinity;
  for (const ts of [a.last_active, latestBusTs, a.updated_at]) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      bestTs = ts;
    }
  }
  return bestTs;
}

export function effectiveState(a: Agent, latestBusTs?: string | null, nowMs?: number): string {
  if (a.retired) return "retired";
  if (a.kind === "temporary" && a.state && (TEMP_LIFECYCLE_STATES as readonly string[]).includes(a.state)) {
    return a.state;
  }
  const last = latestActivityTs(a, latestBusTs);
  if (!last) return "inactive";
  const age = ((nowMs ?? Date.now()) - Date.parse(last)) / 60000;
  if (!Number.isFinite(age)) return "inactive";
  if (age < ACTIVE_MIN) return "active";
  if (age <= IDLE_MIN) return "idle";
  return "inactive";
}

export const STATE_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  working: "bg-sky-500",
  starting: "bg-sky-400 animate-pulse",
  waiting: "bg-amber-500",
  stale: "bg-amber-400 ring-1 ring-amber-600/40",
  failed: "bg-red-500",
  idle: "bg-amber-400",
  inactive: "bg-zinc-300 dark:bg-zinc-600",
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

export const GOAL_STATE_STYLE: Record<MailTask["state"], { label: string; cls: string }> = {
  todo: { label: "To do", cls: "bg-muted text-muted-foreground" },
  doing: { label: "In progress", cls: "bg-primary/10 text-primary" },
  blocked: { label: "Blocked", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-300" },
  done: { label: "Done", cls: "border border-border bg-transparent text-muted-foreground" },
};

export function plainTaskTitle(title: string) {
  return title.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "");
}

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
