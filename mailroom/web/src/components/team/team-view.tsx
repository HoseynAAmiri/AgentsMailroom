"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowLeftRight, Check, ChevronDown, Copy, Loader2, Mail, MessagesSquare, Palette, Pencil, Plug, Save, Shuffle, Square, SquareTerminal, Timer, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { ago, AVATAR_COLORS, avatarColorId, avatarColorValue, CONN_STYLE, connection, countdown, effectiveState, gib, latestActivityTs } from "@/lib/format";
import { useNow } from "@/hooks/use-bus";
import { useCanHover } from "@/hooks/use-mobile";
import type { Agent, Link } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar, CliIcon, Pill, StateDot, Tip } from "@/components/mailroom/bits";
import {
  AGENT_CARDS_GRID_CLS,
  HEALTH_STRIP_GRID_CLS,
  ROUTES_GRID_CLS,
  TEAM_CONTAINER_CLS,
} from "@/components/mailroom/page-skeletons";
import { useMailroom } from "@/components/mailroom/context";
import { AgentDialog } from "./agent-dialog";
import { SessionDialog } from "./session-dialog";
import { MachinesPanel, machineLinkOk } from "@/components/machine/machines-panel";

const ENDED = ["expired", "stopped", "finished", "failed"];

function AvatarColorPicker({ agent }: { agent: Agent }) {
  const { agents, avatarColors, setAvatarColor } = useMailroom();
  const selected = avatarColors?.[agent.id];
  const current = avatarColorId(agent.id, selected);
  const randomize = () => {
    const alternatives = AVATAR_COLORS.filter(({ id }) => id !== current);
    const used = new Set(Array.from(agents.keys(), (id) => avatarColorId(id, avatarColors?.[id])));
    const unused = alternatives.filter(({ id }) => !used.has(id));
    const choices = unused.length ? unused : alternatives;
    setAvatarColor(agent.id, choices[Math.floor(Math.random() * choices.length)].id);
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm" className="touch:size-10" aria-label={`Change avatar color for ${agent.name}`} title="Change avatar color">
            <Palette />
          </Button>
        }
      />
      <PopoverContent className="w-[min(21rem,calc(100vw-1.5rem))]" align="start">
        <div className="flex items-center gap-2">
          <AgentAvatar id={agent.id} size="sm" />
          <PopoverTitle>Avatar color · {agent.name}</PopoverTitle>
        </div>
        <PopoverDescription className="text-xs">Saved in this browser.</PopoverDescription>
        <div className="grid max-h-[min(40dvh,20rem)] grid-cols-10 gap-1 overflow-auto p-1" role="group" aria-label="Color palette">
          {AVATAR_COLORS.map(({ id, label, value }) => (
            <button
              key={id}
              type="button"
              className="flex aspect-square items-center justify-center rounded-md text-white hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ backgroundColor: value }}
              aria-label={label}
              aria-pressed={current === id}
              title={label}
              onClick={() => setAvatarColor(agent.id, id)}
            >
              {current === id && <Check className="size-3.5" />}
            </button>
          ))}
        </div>
        <div className="flex justify-between">
          <Button size="sm" variant="outline" onClick={randomize}><Shuffle /> Randomize</Button>
          <Button size="sm" variant="ghost" disabled={!avatarColorValue(selected)} onClick={() => setAvatarColor(agent.id, null)}>
            Reset to default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IconBtn({ label, onClick, disabled, className, children }: { label: string; onClick: () => void; disabled?: boolean; className?: string; children: React.ReactNode }) {
  const canHover = useCanHover();
  const button = <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} className={cn("touch:size-10", className)}>{children}</Button>;
  if (!canHover) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ConnectDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const { snap } = useMailroom();
  const [text, setText] = useState("");
  useEffect(() => {
    if (!agent) return;
    setText("");
    api
      .instructions(agent.id)
      .then((r) => setText(r.text))
      .catch((e) => setText(String(e)));
  }, [agent]);
  const p = agent ? snap?.presence?.[agent.id] : undefined;
  const resume = agent?.cli && agent.session_id ? snap?.clis[agent.cli]?.resume.replace("{session}", agent.session_id) : null;
  return (
    <Dialog open={!!agent} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5 text-sky-500" /> Connect {agent?.id} · {agent?.name}
          </DialogTitle>
          <DialogDescription>
            This prompt gives the agent its role, mail commands, and idle instructions for its watcher setup.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-1 text-sm text-muted-foreground">
          <li>
            1. {resume ? (
              <>
                Open its session: <code className="rounded bg-muted px-1 font-mono text-xs text-foreground">{resume}</code>
              </>
            ) : (
              <>Open the agent&apos;s session ({agent?.cli ?? "its CLI"}) in a terminal on machine {agent?.machine ?? "A"}.</>
            )}
          </li>
          <li>2. Paste the prompt below. Check the card for inbox and watcher status.</li>
        </ol>
        <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{text || "Loading…"}</pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast.success("Prompt copied");
            } catch {
              toast.error("Could not copy the prompt. Select the text to copy it.");
            }
          }} disabled={!text}>
            <Copy /> Copy prompt
          </Button>
          {p && (
            <span className="text-xs text-muted-foreground">
              Now: {p.unread} unread · {p.checked_at ? `last inbox check ${ago(p.checked_at)}` : "never checked its inbox"}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConnBadge({ a }: { a: Agent }) {
  const { snap } = useMailroom();
  const p = snap?.presence?.[a.id];
  const m = snap?.machines?.find((x) => x.id === (a.machine ?? "A"));
  const c = connection(a, p, (snap?.processes ?? []).some((x) => x.agent === a.id), machineLinkOk(m));
  return (
    <div className={cn("flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs", CONN_STYLE[c.level])}>
      <span className={cn("mt-1 size-2 shrink-0 rounded-full bg-current", c.level === "listening" && "animate-pulse")} />
      <span>
        <span className="font-semibold">{c.label}</span> <span className="opacity-80">· {c.detail}</span>
      </span>
    </div>
  );
}

function AgentCard({ a, subs, onEdit, onConnect, onSession }: { a: Agent; subs: Agent[]; onEdit: () => void; onConnect: () => void; onSession: () => void }) {
  const { snap, startCompose, setView, setFolder, refresh, lastActivity, activityNow } = useMailroom();
  const [showRole, setShowRole] = useState(false);
  const lastAct = latestActivityTs(a, lastActivity.get(a.id), activityNow);
  const st = effectiveState(a, lastActivity.get(a.id), activityNow);
  const procs = (snap?.processes ?? []).filter((p) => p.agent === a.id);
  const links = (snap?.links ?? []).filter((l) => l.a === a.id || l.b === a.id).map((l) => (l.a === a.id ? l.b : l.a));
  const admin = !!snap?.capabilities.admin;
  const preset = a.role_preset ? snap?.roles?.[a.role_preset] : undefined;
  const rolePrompt = (a.role_prompt || preset?.prompt || "").trim();

  const toggleRetired = async () => {
    try {
      await api.upsertAgent({ id: a.id, retired: !a.retired });
      await refresh({ full: true });
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <div className={cn("flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-xs sm:p-4", a.retired && "opacity-60")}>
      <div className="flex items-start gap-3">
        <AgentAvatar id={a.id} agent={a} size="lg" showState />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{a.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <CliIcon cli={a.cli} /> {a.cli ?? a.tool}
            </span>
            · <span>machine {a.machine}</span>
          </div>
        </div>
        <Tip label={lastAct ? `From bus activity (last active ${ago(lastAct)})` : "From bus activity (no recent activity)"} side="left">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
            <StateDot state={st} /> {st}
          </span>
        </Tip>
      </div>

      <div className="mt-3">
        <ConnBadge a={a} />
      </div>

      <div className="mt-3 rounded-md bg-muted/50 px-2.5 py-2">
        <div className="flex items-center gap-2 text-xs">
          <Pill className="bg-sky-500/10 text-sky-700 dark:text-sky-300">{preset?.label ?? a.role ?? "no role"}</Pill>
          {rolePrompt && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" aria-label="Toggle role prompt" className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setShowRole(!showRole)}>
                    <ChevronDown className={cn("size-4 transition-transform", showRole && "rotate-180")} />
                  </button>
                }
              />
              <TooltipContent>{showRole ? "Hide role prompt" : "Show role prompt"}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {rolePrompt ? (
          <p className={cn("mt-1.5 text-xs text-foreground/80", !showRole && "line-clamp-2")}>{rolePrompt}</p>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">No role prompt yet{admin ? " — set one with Edit." : "."}</p>
        )}
      </div>

      <div className="mt-3 text-xs">
        <span className="text-muted-foreground">Now: </span>
        <span className="text-foreground/80" title={a.summary || undefined}>{a.summary || "—"}</span>
        <span className="text-muted-foreground"> · {ago(a.updated_at)}</span>
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Talks with</dt>
        <dd className="flex flex-wrap gap-1">
          <Pill className="bg-muted">user</Pill>
          {links.map((l) => (
            <Pill key={l} className="bg-muted">
              {l}
            </Pill>
          ))}
        </dd>
        <dt className="text-muted-foreground">Process</dt>
        <dd>
          {procs.length
            ? procs.map((p) => `${p.rss_gib} GiB · ${p.n_children} children · up ${(p.uptime_s / 3600).toFixed(1)} h`).join("; ")
            : a.machine === "A"
              ? "none found on machine A"
              : `remote (machine ${a.machine})`}
        </dd>
      </dl>
      {subs.length > 0 && (
        <div className="mt-3 space-y-1 border-t pt-2">
          {subs.map((s) => {
            const subSt = effectiveState(s, lastActivity.get(s.id), activityNow);
            return (
              <div key={s.id} className="flex items-start gap-2 text-xs">
                <StateDot state={subSt} />
                <span className="font-mono">{s.id}</span>
                <span className="min-w-0 break-words text-muted-foreground" title={s.summary}>{s.summary}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-1 pt-3">
        <IconBtn label="Message" disabled={a.retired} onClick={() => startCompose("new", null, { to: a.id })}>
          <Mail />
        </IconBtn>
        <IconBtn label="Connect" disabled={a.retired} onClick={onConnect}>
          <Plug />
        </IconBtn>
        <IconBtn label="Session" onClick={onSession}><SquareTerminal /></IconBtn>
        <IconBtn
          label="Conversations"
          onClick={() => {
            setView("mail");
            setFolder(`agent:${a.id}`);
          }}
        >
          <MessagesSquare />
        </IconBtn>
        <AvatarColorPicker agent={a} />
        {admin && (
          <>
            <IconBtn label="Edit role, CLI, session" onClick={onEdit} className="ml-auto">
              <Pencil />
            </IconBtn>
            <IconBtn label={a.retired ? "Reactivate" : "Retire (kept in the registry)"} onClick={toggleRetired}>
              {a.retired ? <ArchiveRestore /> : <Archive />}
            </IconBtn>
          </>
        )}
      </div>
    </div>
  );
}

function HealthStrip() {
  const { snap, openHuman, setFolder, setView, lastActivity, activityNow } = useMailroom();
  const agents = (snap?.agents ?? []).filter((a) => !a.id.includes(".") && !a.retired && !(a.kind === "temporary" && ENDED.includes(a.state ?? "")));
  const pres = snap?.presence ?? {};
  const conns = agents.map((a) =>
    connection(a, pres[a.id], (snap?.processes ?? []).some((x) => x.agent === a.id), machineLinkOk(snap?.machines?.find((m) => m.id === (a.machine ?? "A")))),
  );
  const listening = conns.filter((c) => c.level === "listening" || c.level === "watcher").length;
  const notReading = agents.filter((a, i) => conns[i].level === "backlog" || conns[i].level === "offline");
  const active = agents.filter((a) => effectiveState(a, lastActivity.get(a.id), activityNow) === "active").length;
  const temps = agents.filter((a) => a.kind === "temporary").length;
  const mem = snap?.memory && "avail_gib" in snap.memory ? snap.memory : null;
  const tile = "rounded-xl border bg-card px-3 py-2.5 text-left sm:px-4 sm:py-3";
  return (
    <div className={HEALTH_STRIP_GRID_CLS}>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">Listening for messages</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {listening}
          <span className="text-base text-muted-foreground"> / {agents.length}</span>
        </div>
      </div>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">Active now</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{active}</div>
      </div>
      <button
        type="button"
        className={cn(tile, "hover:bg-muted", openHuman.length && "border-amber-300 dark:border-amber-800")}
        onClick={() => {
          setView("mail");
          setFolder("needs");
        }}
      >
        <div className="text-xs text-muted-foreground">Waiting on you</div>
        <div className={cn("mt-1 text-2xl font-semibold tabular-nums", openHuman.length && "text-amber-600")}>{openHuman.length}</div>
      </button>
      <div className={cn(tile, "order-last col-span-2 sm:order-none sm:col-span-1", notReading.length && "border-amber-300 dark:border-amber-800")}>
        <div className="text-xs text-muted-foreground">Not reading / unreachable</div>
        <div className={cn("mt-1 truncate text-2xl font-semibold", notReading.length && "text-amber-600")}>
          {notReading.length ? notReading.map((a) => a.id).join(", ") : "none"}
        </div>
      </div>
      <div className={tile}>
        <div className="text-xs text-muted-foreground">Temporary agents · memory</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">
          {temps}
          <span className="text-base text-muted-foreground"> · {mem ? `${mem.avail_gib} GiB free` : "—"}</span>
        </div>
      </div>
    </div>
  );
}

function LinksEditor() {
  const { snap, refresh } = useMailroom();
  const team = (snap?.agents ?? [])
    .filter((a) => (a.kind ?? "permanent") === "permanent" && !a.retired && !a.id.includes("."))
    .sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(team.map((a) => a.id));
  const pairs = team.flatMap((a, i) => team.slice(i + 1).map((b) => ({ a, b })));
  const [links, setLinks] = useState<Link[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const admin = !!snap?.capabilities.admin;

  useEffect(() => {
    if (!dirty) setLinks(snap?.links ?? []);
  }, [snap?.links, dirty]);

  const matches = (l: Link, a: string, b: string) => (l.a === a && l.b === b) || (l.a === b && l.b === a);
  const editable = (l: Link) => ids.has(l.a) && ids.has(l.b);
  const toggle = (a: string, b: string, checked: boolean) => {
    setDirty(true);
    setLinks((ls) => {
      if (!checked) return ls.filter((l) => !matches(l, a, b));
      const original = snap?.links.find((l) => matches(l, a, b));
      return [...ls, original ?? { a, b, note: "" }];
    });
  };
  const otherLinks = (snap?.links ?? []).filter((l) => !editable(l));
  const enabledCount = links.filter(editable).length;
  const save = async () => {
    setBusy(true);
    try {
      setLinks(await api.setLinks([...links.filter(editable), ...otherLinks]));
      await refresh({ full: true });
      setDirty(false);
      toast.success("Routes saved");
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Who talks to whom"
      description="Routes allow messages both ways. They only apply to messages between agents."
      actions={
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {dirty ? "Unsaved changes" : `${enabledCount} of ${pairs.length} allowed`}
          </span>
          {admin && (
            <IconBtn label="Save routes" onClick={() => void save()} disabled={!dirty || busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Save />}
            </IconBtn>
          )}
        </div>
      }
    >
      {pairs.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Routes appear when at least two team agents are active.</p>
      ) : (
        <ul className={ROUTES_GRID_CLS}>
          {pairs.map(({ a, b }) => {
            const link = links.find((l) => matches(l, a.id, b.id));
            const label = `${a.id} and ${b.id}`;
            return (
              <li key={label} className="min-w-0 rounded-lg border bg-card px-3 py-2">
                <div className="flex min-h-8 items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                    <span className="font-mono font-medium break-all" title={a.name}>{a.id}</span>
                    <ArrowLeftRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-mono font-medium break-all" title={b.name}>{b.id}</span>
                  </div>
                  <Switch checked={!!link} disabled={!admin || busy} onCheckedChange={(checked) => toggle(a.id, b.id, checked)} aria-label={`Allow messages between ${label}`} />
                </div>
                {link && admin && (
                  <Textarea
                    aria-label={`Note for ${label}`}
                    value={link.note ?? ""}
                    disabled={busy}
                    maxLength={200}
                    placeholder="Add a note"
                    rows={1}
                    onChange={(e) => {
                      const note = e.target.value;
                      setDirty(true);
                      setLinks((ls) => ls.map((l) => matches(l, a.id, b.id) ? { ...l, note } : l));
                    }}
                    className="mt-1.5 min-h-8 resize-none px-2 py-1.5 text-sm md:text-xs"
                  />
                )}
                {link?.note && !admin && <p className="mt-1 text-xs break-words text-muted-foreground">{link.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
      {otherLinks.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Temporary or retired agents</span>
          {otherLinks.map((l) => (
            <span key={`${l.a}–${l.b}`} className="max-w-full rounded border px-1.5 py-0.5 font-mono break-all" title={l.note}>
              {l.a} ↔ {l.b}
            </span>
          ))}
        </div>
      )}
    </Section>
  );
}

function TempAgents({ onSession }: { onSession: (id: string) => void }) {
  const { snap, refresh, setSummonOpen, startCompose, setView, setFolder, lastActivity, activityNow } = useMailroom();
  useNow(1000);
  const [stopping, setStopping] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const temps = (snap?.agents ?? []).filter((a) => a.kind === "temporary").reverse();
  const history = temps.filter((a) => ENDED.includes(a.state ?? ""));
  const sessions = showHistory ? history : temps.filter((a) => !ENDED.includes(a.state ?? ""));
  const admin = !!snap?.capabilities.admin;

  const stop = async (id: string) => {
    setStopping(id);
    try {
      await api.stop(id);
      toast.success(`${id} stopped`);
      await refresh({ full: true });
    } catch (err) {
      toast.error(String(err instanceof Error ? err.message : err));
    } finally {
      setStopping(null);
    }
  };

  return (
    <Section
      title="Temporary agents"
      description={`Timed systemd units on machine A (SSH sessions on machine B). Limit ${snap?.limits.max_active_temp ?? "?"} at once, ${snap?.limits.memory_max_gib ?? "?"} GiB cap each.`}
      actions={
        <div className="flex flex-wrap gap-2">
          {history.length > 0 && (
            <Button size="sm" variant="outline" aria-pressed={showHistory} onClick={() => setShowHistory((open) => !open)}>
              <Archive /> {showHistory ? "Active agents" : `History (${history.length})`}
            </Button>
          )}
          <IconBtn label="Summon agent" onClick={() => setSummonOpen(true)}>
            <Timer />
          </IconBtn>
        </div>
      }
    >
      {sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {showHistory ? "No past sessions." : "No active temporary agents."}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="hidden sm:table-cell">CLI</TableHead>
                <TableHead className="min-w-36 sm:w-56">Time</TableHead>
                <TableHead className="hidden md:table-cell">Memory peak</TableHead>
                <TableHead className="hidden sm:table-cell">State</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((a) => {
                const live = !ENDED.includes(a.state ?? "");
                const total = (a.ttl_min ?? 1) * 60000;
                const left = Math.max(0, Date.parse(a.expires_at ?? "") - Date.now());
                return (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <AgentAvatar id={a.id} agent={a} size="sm" showState />
                        <div>
                          <div className="font-medium">
                            {a.name} <span className="font-mono text-xs text-muted-foreground">{a.id}</span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            machine {a.machine ?? "A"} · {a.access === "full" ? "full auto" : "standard"}
                            {a.peers?.length ? ` · talks with ${a.peers.join(", ")}` : ""}
                            {a.model ? ` · ${a.model}` : ""}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="inline-flex items-center gap-1 text-xs">
                        <CliIcon cli={a.cli} /> {a.cli}
                      </span>
                    </TableCell>
                    <TableCell>
                      {live ? (
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="font-mono tabular-nums">{countdown(a.expires_at)} left</span>
                            <span className="text-muted-foreground">of {a.ttl_min} min</span>
                          </div>
                          <Progress value={(left / total) * 100} />
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground">
                          <div>{a.state} · {ago(a.ended_at)}</div>
                          {a.summary && <div>{a.summary}</div>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">{gib(a.mem_peak_bytes)}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {(() => {
                        const st = effectiveState(a, lastActivity.get(a.id), activityNow);
                        return (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <StateDot state={st} /> {st}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <IconBtn label="Conversations" onClick={() => { setView("mail"); setFolder(`agent:${a.id}`); }}>
                          <Mail />
                        </IconBtn>
                        {live && (
                          <IconBtn label="Message" onClick={() => startCompose("new", null, { to: a.id })}>
                            <MessagesSquare />
                          </IconBtn>
                        )}
                        <IconBtn label="Session" onClick={() => onSession(a.id)}><SquareTerminal /></IconBtn>
                        <AvatarColorPicker agent={a} />
                        {live && admin && (
                          <IconBtn label="Stop agent" onClick={() => stop(a.id)} disabled={stopping === a.id} className="text-destructive hover:bg-destructive/10">
                            {stopping === a.id ? <Loader2 className="animate-spin" /> : <Square />}
                          </IconBtn>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}

export function TeamView() {
  const { snap, lastActivity, activityNow } = useMailroom();
  const [editing, setEditing] = useState<Agent | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connecting, setConnecting] = useState<Agent | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const agents = useMemo(() => snap?.agents ?? [], [snap?.agents]);
  const team = agents.filter((a) => (a.kind ?? "permanent") === "permanent" && !a.id.includes("."));
  const admin = !!snap?.capabilities.admin;
  const order = (a: Agent) => (a.retired ? 1 : 0);

  return (
    <ScrollArea className="h-full">
      <div className={TEAM_CONTAINER_CLS}>
        {!admin && snap && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            View only: this port is shared with machine B. Register agents, edit routes and summon from the local command center at{" "}
            <a className="font-medium underline" href={snap.capabilities.admin_url ?? "#"}>
              {snap.capabilities.admin_url}
            </a>
            .
          </div>
        )}
        <HealthStrip />
        <Section
          title="Team"
          description="Use Connect for the agent’s role, mail commands, and watcher instructions."
          actions={
            admin && (
                <IconBtn label="Register agent" onClick={() => { setEditing(null); setDialogOpen(true); }} className="ml-auto">
                  <UserPlus />
                </IconBtn>
            )
          }
        >
          <div className={AGENT_CARDS_GRID_CLS}>
            {team
              .slice()
              .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
              .map((a) => (
                <AgentCard
                  key={a.id}
                  a={a}
                  subs={agents.filter(
                    (s) =>
                      s.id.startsWith(`${a.id}.`) &&
                      !s.retired &&
                      effectiveState(s, lastActivity.get(s.id), activityNow) !== "inactive",
                  )}
                  onEdit={() => {
                    setEditing(a);
                    setDialogOpen(true);
                  }}
                  onConnect={() => setConnecting(a)}
                  onSession={() => setSessionId(a.id)}
                />
              ))}
          </div>
        </Section>
        <Section title="Machines" description="Where agents run and whether they reach the bus. Machine B is probed over SSH every 60 s.">
          <MachinesPanel />
        </Section>
        <TempAgents onSession={setSessionId} />
        <LinksEditor />
      </div>
      <AgentDialog open={dialogOpen} onOpenChange={(v) => { setDialogOpen(v); if (!v) setEditing(null); }} agent={editing} />
      <ConnectDialog agent={connecting} onClose={() => setConnecting(null)} />
      {sessionId && <SessionDialog key={sessionId} id={sessionId} onClose={() => setSessionId(null)} />}
    </ScrollArea>
  );
}
