export type EventType =
  | "message"
  | "task.started"
  | "task.blocked"
  | "task.completed"
  | "task.failed"
  | "human.needed"
  | "agent.status";

export interface Ref {
  kind: string;
  value: string;
}

export interface BusEvent {
  id: string;
  ts: string;
  type: EventType;
  from: string;
  to: string;
  cc?: string[];
  task_id?: string | null;
  parent_task_id?: string | null;
  subject?: string | null;
  in_reply_to?: string | null;
  body: string;
  refs?: Ref[];
  state?: string;
}

export type AgentKind = "permanent" | "temporary" | "subagent";

export interface Agent {
  id: string;
  name: string;
  role?: string;
  machine?: string;
  tool?: string;
  cli?: string;
  kind?: AgentKind;
  state?: string;
  summary?: string;
  updated_at?: string;
  last_active?: string;
  retired?: boolean;
  session_id?: string;
  role_preset?: string | null;
  role_prompt?: string | null;
  workdir?: string;
  notes?: string;
  // temporary agents
  summoned_at?: string;
  expires_at?: string;
  ended_at?: string;
  ttl_min?: number;
  access?: "standard" | "full";
  model?: string | null;
  peers?: string[];
  unit?: string;
  mem_peak_bytes?: number;
}

export interface Link {
  a: string;
  b: string;
  note?: string;
}

export interface Task {
  task_id: string;
  parent_task_id?: string | null;
  owner?: string | null;
  state: "open" | "started" | "blocked" | "completed" | "failed" | "waiting_human";
  title?: string;
  updated_at?: string;
}

export interface UserState {
  read_upto: number;
  read: string[];
  unread: string[];
  flagged: string[];
  deleted: Record<string, string>;
  archived?: Record<string, string>;
}

export interface Run {
  name: string;
  status: string;
  machine: string;
  cpu?: string;
  mem?: string;
}

export interface Proc {
  agent: string;
  pid: number;
  uptime_s: number;
  rss_gib: number;
  cpu_pct: number;
  n_children: number;
  children: { pid: number; rss_mib: number; cpu: number; cmd: string }[];
}

export interface CliInfo {
  label: string;
  available: boolean;
  resume: string;
  standard: string[];
  full: string[];
}

export interface Presence {
  unread: number;
  oldest_unread_ts: string | null;
  seen_id: string | null;
  checked_at: string | null;
  checked_min_ago: number | null;
  listening: boolean;
  watchers: { thread: string | null; last_queued_at: string | null; file_age_min: number }[];
}

export interface RolePreset {
  label: string;
  prompt: string;
}

export interface MachineInfo {
  id: string;
  label: string;
  kind: "local" | "ssh";
  note?: string;
  tunnel_unit?: string;
  repo?: string;
  checked_at: string | null;
  reachable?: boolean;
  error?: string;
  latency_ms?: number;
  tunnel_active?: boolean;
  bus_via_tunnel?: boolean;
  os?: string;
  wsl?: boolean;
  repo_found?: boolean;
  mem_total_gib?: number;
  mem_avail_gib?: number;
  clis: string[];
}

export interface Snapshot {
  event_cursor?: string;
  tasks_revision?: string;
  machines: MachineInfo[];
  presence: Record<string, Presence>;
  roles: Record<string, RolePreset>;
  agents: Agent[];
  links: Link[];
  events: BusEvent[];
  full: boolean;
  last_id: string | null;
  tasks: Task[];
  runs: Run[];
  processes: Proc[];
  memory: { total_gib: number; avail_gib: number; swap_used_gib: number } | Record<string, never>;
  user_state: UserState;
  capabilities: { admin: boolean; admin_url: string | null };
  clis: Record<string, CliInfo>;
  limits: {
    max_ttl_min: number;
    max_active_temp: number;
    summon_est_gib: number;
    min_avail_after_gib: number;
    memory_max_gib: number;
  };
  generated_at: string;
}

export interface Attachment {
  name: string;
  size: number;
  modified: string;
}
