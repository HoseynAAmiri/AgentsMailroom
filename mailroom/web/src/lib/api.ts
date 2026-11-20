import type { Agent, Attachment, BusEvent, Link, MailTaskIndex, Ref, UserState } from "./types";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { cache: "no-store", ...init });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export interface OutgoingMessage {
  to: string;
  cc: string[];
  subject?: string | null;
  task_id?: string | null;
  in_reply_to?: string | null;
  body: string;
  refs?: Ref[];
}

export const api = {
  mailTasks: () => call<MailTaskIndex>("/api/todo?mail=1"),
  goalChoices: () => call<{ tasks: { id: string; title: string }[] }>("/api/todo"),
  goalTag: (eventId: string) => call<{ override: boolean; task_id: string | null }>(`/api/todo?event_id=${encodeURIComponent(eventId)}`),
  linkGoalFile: (id: string, path: string) => post<{ export_warning?: string }>("/api/todo", { action: "link", id, path }),
  send: (m: OutgoingMessage) => post<BusEvent>("/api/events", { type: "message", from: "user", ...m }),
  uploadAttachment: async (file: Blob, name: string, taskId?: string) => {
    const url = taskId ? `/api/attachments?task_id=${encodeURIComponent(taskId)}` : "/api/attachments";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": name },
      body: file,
    });
    const data = res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as { error?: string; name?: string; url?: string; link_warning?: string; export_warning?: string });
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as { name: string; size: number; url: string; ref: string; link_warning?: string; export_warning?: string };
  },
  userState: (action: "read" | "unread" | "read_all" | "flag" | "unflag" | "delete" | "restore" | "archive" | "unarchive", ids: string[] = []) =>
    post<UserState>("/api/user-state", { action, ids }),
  upsertAgent: (a: Partial<Agent> & { id: string }) => post<Agent>("/api/agents", a),
  setLinks: (links: Link[]) => post<Link[]>("/api/links", { links }),
  summon: (req: SummonRequest) => post<{ agent: Agent; brief: BusEvent; command: string[] }>("/api/summon", req),
  stop: (id: string) => post<{ stopped: string }>(`/api/sessions/${encodeURIComponent(id)}/stop`, {}),
  log: (id: string) => call<{ agent: string; log: string }>(`/api/sessions/${encodeURIComponent(id)}/log`),
  saveSessionId: (id: string, session_id: string, previous_id: string) =>
    post<Agent>(`/api/sessions/${encodeURIComponent(id)}/reference`, { session_id, previous_id }),
  instructions: (id: string) => call<{ agent: string; text: string }>(`/api/agents/${encodeURIComponent(id)}/instructions`),
  attachments: (refresh = false) => call<Attachment[]>(refresh ? "/api/attachments?refresh=1" : "/api/attachments"),
  repoDir: (path = "") => call<RepoDirListing>(`/api/repo-dir?path=${encodeURIComponent(path)}`),
};

export interface RepoDirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
  modified: string;
  viewable: boolean;
}

export interface RepoDirListing {
  path: string;
  abs_path?: string;
  parent: string | null;
  entries: RepoDirEntry[];
}

export interface SummonRequest {
  cli: string;
  machine: string;
  name?: string;
  role?: string;
  role_preset?: string;
  role_prompt?: string;
  ttl_min: number;
  access: "standard" | "full";
  model?: string;
  peers: string[];
  cc: string[];
  subject?: string;
  task_id?: string;
  brief: string;
}

/** `file:coordination/attachments/<x>` refs open through the bus's /attach/ route. */
export function attachmentHref(value: string): string | null {
  const m = value.match(/(?:^|\/)coordination\/attachments\/(.+)$/) || value.match(/^attachments\/(.+)$/);
  return m ? `/attach/${m[1].split("/").map(encodeURIComponent).join("/")}` : null;
}

/** Any repo-relative file ref (`cases/...`, `docs/...`) opens through the bus's read-only /repo/ route. */
export function fileHref(value: string): string | null {
  const a = attachmentHref(value);
  if (a) return a;
  const rel = value.trim().replace(/^\.?\//, "");
  if (!rel || /^[a-z]+:\/\//i.test(rel) || rel.startsWith("/") || rel.startsWith("~") || rel.split("/").some((p) => p.startsWith("."))) return null;
  if (!/\.[A-Za-z0-9]+$/.test(rel)) return null;
  return `/repo/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export type FileKind = "image" | "pdf" | "markdown" | "json" | "text";

export function fileKind(name: string): FileKind {
  const n = name.toLowerCase();
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(n)) return "image";
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".md")) return "markdown";
  if (/\.(json|jsonl)$/.test(n)) return "json";
  return "text";
}
