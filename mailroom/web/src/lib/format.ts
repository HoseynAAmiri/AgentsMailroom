import type { Agent, BusEvent, MailTask, Presence } from "./types";

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
export const MAX_FUTURE_SKEW_MS = 5_000;
export const TEMP_LIFECYCLE_STATES = ["starting", "expired", "stopped", "finished", "failed"] as const;

export function isFutureOutlier(ms: number, nowMs: number = Date.now()): boolean {
  return ms - nowMs > MAX_FUTURE_SKEW_MS;
}

export function resolveActivityNow(tickNowMs: number, snapshotReceivedAtMs?: number | null): number {
  if (snapshotReceivedAtMs != null && Number.isFinite(snapshotReceivedAtMs)) {
    return Math.max(tickNowMs, snapshotReceivedAtMs);
  }
  return tickNowMs;
}

export function buildLastActivityMap(events: readonly BusEvent[], nowMs: number = Date.now()): Map<string, string> {
  const m = new Map<string, string>();
  const bestMs = new Map<string, number>();
  for (const e of events) {
    if (!e.from || e.from === "user" || !e.ts) continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms) || isFutureOutlier(ms, nowMs)) continue;
    if (ms > (bestMs.get(e.from) ?? -Infinity)) {
      bestMs.set(e.from, ms);
      m.set(e.from, e.ts);
    }
  }
  return m;
}

export function latestActivityTs(a: Agent, latestBusTs?: string | null, nowMs: number = Date.now()): string | null {
  let bestTs: string | null = null;
  let bestMs = -Infinity;
  for (const ts of [a.last_active, latestBusTs]) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && !isFutureOutlier(ms, nowMs) && ms > bestMs) {
      bestMs = ms;
      bestTs = ts;
    }
  }
  return bestTs;
}

export function effectiveState(a: Agent, latestBusTs?: string | null, nowMs: number = Date.now()): string {
  if (a.retired) return "retired";
  if (a.kind === "temporary" && a.state && (TEMP_LIFECYCLE_STATES as readonly string[]).includes(a.state)) {
    return a.state;
  }
  const last = latestActivityTs(a, latestBusTs, nowMs);
  if (!last) return "inactive";
  const age = (nowMs - Date.parse(last)) / 60000;
  if (!Number.isFinite(age) || age < -(MAX_FUTURE_SKEW_MS / 60000)) return "inactive";
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

export const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

export const PRIORITY_STYLE: Record<"high" | "normal" | "low", { label: string; cls: string; dotCls: string }> = {
  high: {
    label: "High",
    cls: "border-red-500/45 bg-red-500/15 text-red-700 dark:text-red-300",
    dotCls: "text-red-600 dark:text-red-400",
  },
  normal: {
    label: "Normal",
    cls: "border-amber-500/45 bg-amber-500/15 text-amber-800 dark:text-amber-300",
    dotCls: "text-amber-600 dark:text-amber-400",
  },
  low: {
    label: "Low",
    cls: "border-emerald-500/45 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dotCls: "text-emerald-600 dark:text-emerald-400",
  },
};

export function priorityRank(priority?: string | null): number {
  const key = (priority ?? "normal").toLowerCase();
  return key in PRIORITY_RANK ? PRIORITY_RANK[key as keyof typeof PRIORITY_RANK] : PRIORITY_RANK.normal;
}

/** Return a copy sorted High > Normal > Low while preserving original order within each tier. */
export function sortTasksByPriority<T extends { priority?: string | null }>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

/** True when a task is ready to start next (todo and not held on a USER decision). */
export function isTaskReadyNext(task: { state: string; decision?: number | boolean | null }): boolean {
  return task.state === "todo" && !task.decision;
}

/** True when a task has active work in progress (doing and not held on a USER decision). */
export function isTaskInProgress(task: { state: string; decision?: number | boolean | null }): boolean {
  return task.state === "doing" && !task.decision;
}

export const TASK_STAGES = [
  "Inbox",
  "Assign",
  "Stage",
  "Run",
  "Review",
  "Done",
] as const;

export type TaskStage = (typeof TASK_STAGES)[number];

export const TASK_STAGE_STYLE: Record<TaskStage, { label: TaskStage; cls: string }> = {
  Inbox: { label: "Inbox", cls: "border-zinc-400/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300" },
  Assign: { label: "Assign", cls: "border-indigo-500/35 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300" },
  Stage: { label: "Stage", cls: "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300" },
  Run: { label: "Run", cls: "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  Review: { label: "Review", cls: "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300" },
  Done: { label: "Done", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
};

export const TASK_STAGE_META: Record<TaskStage, { label: string; shortLabel: string; description: string }> = {
  Inbox: { label: "Inbox", shortLabel: "Inbox", description: "New / untriaged" },
  Assign: { label: "Assign", shortLabel: "Assign", description: "Needs owner & scope" },
  Stage: { label: "Stage", shortLabel: "Stage", description: "Prepared & preflight" },
  Run: { label: "Run", shortLabel: "Run", description: "Active execution" },
  Review: { label: "Review", shortLabel: "Review", description: "Review results & referee check" },
  Done: { label: "Done", shortLabel: "Done", description: "Finished & delivered" },
};

const TASK_STAGE_SET = new Set<string>(TASK_STAGES);
const TASK_STAGE_PREFIX_RE = /^\s*\[([^\]]*)\](?:\s*([\s\S]*))?$/;

export type TaskStageKind = "valid" | "unprefixed" | "malformed";

export interface ParsedTaskStage {
  stage: TaskStage | null;
  kind: TaskStageKind;
  rawPrefix: string | null;
  text: string;
}

/** Parse the D38 `[Stage]` prefix strictly without coercing lowercase/padded/unknown tokens. */
export function parseTaskStage(nextAction?: string | null): ParsedTaskStage {
  if (!nextAction) return { stage: null, kind: "unprefixed", rawPrefix: null, text: "" };
  const trimmed = nextAction.trim();
  if (!trimmed) return { stage: null, kind: "unprefixed", rawPrefix: null, text: "" };
  const match = TASK_STAGE_PREFIX_RE.exec(nextAction);
  if (!match) return { stage: null, kind: "unprefixed", rawPrefix: null, text: trimmed };
  const rawPrefix = match[1];
  if (TASK_STAGE_SET.has(rawPrefix)) {
    return {
      stage: rawPrefix as TaskStage,
      kind: "valid",
      rawPrefix,
      text: (match[2] ?? "").trim(),
    };
  }
  return { stage: null, kind: "malformed", rawPrefix, text: trimmed };
}

export interface TaskDocFolder {
  folder: string;
  label: string;
  slug: string;
  context: string | null;
  dossier: string | null;
  pdf: string | null;
  extra: string[];
}

export interface TaskDocLinks {
  folder: string | null;
  folderLabel: string | null;
  context: string | null;
  dossier: string | null;
  pdf: string | null;
  folders: TaskDocFolder[];
  ownedFolders: TaskDocFolder[];
  relatedLinks: string[];
  other: string[];
}

const GOAL_FOLDER_RE = /^(docs\/goals-and-tasks\/((G[1-9]\d*)\/([^/]+)))\//;
const TASK_ID_RE = /^([A-Za-z]+\d+)\.(\d+)$/;
const NUMBERED_TASK_SLUG_RE = /^g(\d+)_(\d+)(?:_|$)/i;

/** Classify a task's linked repository paths, prioritizing its canonical task folder while keeping multi-report links reachable. */
export function extractTaskDocLinks(links?: readonly string[] | null, taskId?: string | null): TaskDocLinks {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of links ?? []) {
    const clean = raw.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      unique.push(clean);
    }
  }

  interface FolderBucket {
    folder: string;
    label: string;
    goal: string;
    slug: string;
    items: string[];
  }

  const bucketMap = new Map<string, FolderBucket>();
  const standalone: string[] = [];

  for (const item of unique) {
    const m = GOAL_FOLDER_RE.exec(item);
    if (m) {
      const [, folder, label, goal, slug] = m;
      let bucket = bucketMap.get(folder);
      if (!bucket) {
        bucket = { folder, label, goal, slug, items: [] };
        bucketMap.set(folder, bucket);
      }
      bucket.items.push(item);
    } else {
      standalone.push(item);
    }
  }

  const classifyFolder = (bucket: FolderBucket): { doc: TaskDocFolder; goal: string; richness: number } => {
    let context: string | null = null;
    let dossier: string | null = null;
    const contextCandidates: string[] = [];
    const folderPdfs: string[] = [];
    const extra: string[] = [];

    for (const item of bucket.items) {
      const base = (item.split("/").at(-1) ?? "").toLowerCase();
      if (/^context.*\.md$/.test(base)) {
        contextCandidates.push(item);
      } else if (!dossier && base === "dossier.md") {
        dossier = item;
      } else if (base.endsWith(".pdf")) {
        folderPdfs.push(item);
      } else {
        extra.push(item);
      }
    }

    if (contextCandidates.length) {
      context = contextCandidates.find((p) => p.split("/").at(-1)?.toLowerCase() === "context.md") ?? contextCandidates[0];
      for (const p of contextCandidates) {
        if (p !== context) extra.push(p);
      }
    }

    let pdf: string | null = null;
    if (folderPdfs.length) {
      const canonicalPdf = `${bucket.slug.toLowerCase()}.pdf`;
      pdf = folderPdfs.find((p) => p.split("/").at(-1)?.toLowerCase() === canonicalPdf) ?? folderPdfs[0];
      for (const p of folderPdfs) {
        if (p !== pdf) extra.push(p);
      }
    }

    const richness = (context ? 1 : 0) + (dossier ? 1 : 0) + (pdf ? 1 : 0);
    return {
      doc: {
        folder: bucket.folder,
        label: bucket.label,
        slug: bucket.slug,
        context,
        dossier,
        pdf,
        extra,
      },
      goal: bucket.goal,
      richness,
    };
  };

  const tidMatch = TASK_ID_RE.exec((taskId ?? "").trim());
  const taskGoalDir = tidMatch ? tidMatch[1].toUpperCase() : null;
  const taskSlugPrefix = tidMatch ? `${tidMatch[1].toLowerCase()}_${tidMatch[2]}` : null;

  const folderTier = (entry: { doc: TaskDocFolder; goal: string }): number => {
    const slugLower = entry.doc.slug.toLowerCase();
    if (taskSlugPrefix && (slugLower === taskSlugPrefix || slugLower.startsWith(`${taskSlugPrefix}_`))) {
      return 0;
    }
    const inGoal = taskGoalDir !== null && entry.goal === taskGoalDir;
    const hasCoreDoc = entry.doc.context !== null || entry.doc.dossier !== null;
    if (inGoal && hasCoreDoc) return 1;
    if (inGoal) return 2;
    if (hasCoreDoc) return 3;
    return 4;
  };

  const ranked = [...bucketMap.values()]
    .map(classifyFolder)
    .sort((a, b) => {
      const tierDiff = folderTier(a) - folderTier(b);
      if (tierDiff !== 0) return tierDiff;
      if (a.richness !== b.richness) return b.richness - a.richness;
      return a.doc.label.localeCompare(b.doc.label);
    });

  const folders = ranked.map((r) => r.doc);
  let ownedEntries = ranked;
  if (taskGoalDir) {
    const sameGoal = ranked.filter((r) => r.goal === taskGoalDir);
    const nonOtherTask = sameGoal.filter((r) => {
      const sm = NUMBERED_TASK_SLUG_RE.exec(r.doc.slug);
      if (!sm) return true;
      return `g${sm[1]}_${sm[2]}` === taskSlugPrefix;
    });
    ownedEntries = nonOtherTask.length > 0 ? nonOtherTask : sameGoal;
  }
  const ownedFolders = ownedEntries.map((r) => r.doc);
  const ownedPrefixes = ownedFolders.map((f) => `${f.folder}/`);
  const relatedLinks = unique.filter((item) => !ownedPrefixes.some((prefix) => item.startsWith(prefix)));

  if (folders.length > 0) {
    const primary = ownedFolders[0] ?? null;
    const primarySet = primary
      ? new Set([primary.context, primary.dossier, primary.pdf].filter((p): p is string => !!p))
      : new Set<string>();
    return {
      folder: primary?.folder ?? null,
      folderLabel: primary?.label ?? null,
      context: primary?.context ?? null,
      dossier: primary?.dossier ?? null,
      pdf: primary?.pdf ?? null,
      folders,
      ownedFolders,
      relatedLinks,
      other: unique.filter((item) => !primarySet.has(item)),
    };
  }

  let context: string | null = null;
  let dossier: string | null = null;
  let pdf: string | null = null;
  const other: string[] = [];
  for (const item of standalone) {
    const base = (item.split("/").at(-1) ?? "").toLowerCase();
    if (!context && /^context.*\.md$/.test(base)) {
      context = item;
    } else if (!dossier && base === "dossier.md") {
      dossier = item;
    } else if (!pdf && base.endsWith(".pdf")) {
      pdf = item;
    } else {
      other.push(item);
    }
  }

  return {
    folder: null,
    folderLabel: null,
    context,
    dossier,
    pdf,
    folders: [],
    ownedFolders: [],
    relatedLinks: unique,
    other,
  };
}

/** Resolve a task's primary folder (linked task folder first, else its goal folder `docs/goals-and-tasks/G<n>`). */
export function resolveTaskFilesFolder(
  task: { id: string; goal_id?: string | null; links?: readonly string[] | null },
): TaskDocFolder | null {
  const { ownedFolders } = extractTaskDocLinks(task.links, task.id);
  if (ownedFolders.length > 0) return ownedFolders[0];
  const explicitGoal = (task.goal_id ?? "").trim().toUpperCase();
  const idMatch = /^(G[1-9]\d*)\./i.exec(task.id.trim());
  const goalId = explicitGoal || (idMatch ? idMatch[1].toUpperCase() : "");
  if (!/^G[1-9]\d*$/.test(goalId)) return null;
  return {
    folder: `docs/goals-and-tasks/${goalId}`,
    label: goalId,
    slug: goalId,
    context: null,
    dossier: null,
    pdf: null,
    extra: [],
  };
}

export interface StagedTaskItem<T> {
  task: T;
  parsed: ParsedTaskStage;
}

/** Group tasks into the 6 canonical D38 stage columns while retaining unprefixed/malformed rows separately. */
export function groupTasksByStage<T extends { next_action?: string | null }>(
  tasks: readonly T[],
): {
  columns: { stage: TaskStage; items: StagedTaskItem<T>[] }[];
  unstaged: StagedTaskItem<T>[];
} {
  const byStage = new Map<TaskStage, StagedTaskItem<T>[]>(TASK_STAGES.map((stage) => [stage, []]));
  const unstaged: StagedTaskItem<T>[] = [];
  for (const task of tasks) {
    const parsed = parseTaskStage(task.next_action);
    const entry = { task, parsed };
    if (parsed.stage) {
      byStage.get(parsed.stage)!.push(entry);
    } else {
      unstaged.push(entry);
    }
  }
  return {
    columns: TASK_STAGES.map((stage) => ({ stage, items: byStage.get(stage)! })),
    unstaged,
  };
}

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

export interface TaskProgressSummary {
  total: number;
  done: number;
  remaining: number;
  donePct: number;
  doneWidthPct: number;
}

/** Summarize canonical [Done] completion progress on full scope. */
export function summarizeTaskProgress(tasks: readonly { next_action: string }[]): TaskProgressSummary {
  const total = tasks.length;
  let done = 0;
  for (const task of tasks) {
    const { stage } = parseTaskStage(task.next_action);
    if (stage === "Done") done += 1;
  }
  const remaining = Math.max(0, total - done);
  return {
    total,
    done,
    remaining,
    donePct: total ? Math.round((done / total) * 100) : 0,
    doneWidthPct: total ? (done / total) * 100 : 0,
  };
}

export interface RolePresetInfo {
  label: string;
  prompt: string;
}

/** Resolve a case-insensitive role preset key by preset key or preset label. */
export function findMatchingRolePreset(
  role: string | null | undefined,
  roles: Readonly<Record<string, RolePresetInfo>>,
): string | null {
  const trimmed = (role ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  for (const [key, info] of Object.entries(roles)) {
    if (key.toLowerCase() === trimmed || info.label.trim().toLowerCase() === trimmed) {
      return key;
    }
  }
  return null;
}

/** Apply a role preset pill click, syncing role label and updating default prompt when uncustomized. */
export function applyRolePresetSelection(
  form: Partial<Agent>,
  presetKey: string,
  roles: Readonly<Record<string, RolePresetInfo>>,
): Partial<Agent> {
  const preset = roles[presetKey];
  if (!preset) return form;
  const currentPrompt = (form.role_prompt ?? "").trim();
  const isUneditedOrPresetPrompt = !currentPrompt || Object.values(roles).some((r) => r.prompt.trim() === currentPrompt);
  return {
    ...form,
    role_preset: presetKey,
    role: preset.label.toLowerCase(),
    role_prompt: isUneditedOrPresetPrompt ? preset.prompt : form.role_prompt,
  };
}

/** Update the Role label text input and sync/clear role_preset when the label matches a preset. */
export function applyRoleLabelChange(
  form: Partial<Agent>,
  roleValue: string,
  roles: Readonly<Record<string, RolePresetInfo>>,
): Partial<Agent> {
  return {
    ...form,
    role: roleValue,
    role_preset: findMatchingRolePreset(roleValue, roles),
  };
}

/** Build an `/api/agents` upsert payload with role synced to any valid preset and preset-identical prompt normalized to null. */
export function buildAgentUpsertPayload(
  form: Partial<Agent>,
  roles: Readonly<Record<string, RolePresetInfo>>,
): Partial<Agent> & { id: string } {
  const presetKey = form.role_preset && roles[form.role_preset] ? form.role_preset : null;
  const preset = presetKey ? roles[presetKey] : undefined;
  const role = preset ? preset.label.toLowerCase() : (form.role?.trim() || "");
  const rawPrompt = (form.role_prompt ?? "").trim();
  const rolePrompt = !rawPrompt || (preset && rawPrompt === preset.prompt.trim()) ? null : rawPrompt;
  return {
    id: String(form.id ?? "").trim(),
    name: form.name?.trim(),
    role,
    role_preset: presetKey,
    role_prompt: rolePrompt,
    machine: form.machine?.trim(),
    cli: form.cli,
    session_id: form.session_id?.trim(),
    workdir: form.workdir?.trim(),
    notes: form.notes,
  };
}
