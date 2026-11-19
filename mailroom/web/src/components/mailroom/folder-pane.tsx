"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, Archive, ChevronDown, ChevronRight, Flag, Inbox, ListTodo, MessagesSquare, Send, Timer, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { threadInFolder, type FolderId } from "@/lib/threads";
import { countdown } from "@/lib/format";
import { useNow } from "@/hooks/use-bus";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AgentAvatar, CliIcon } from "./bits";
import { useMailroom } from "./context";

function FolderRow({
  id,
  icon: Icon,
  label,
  count,
  countKind = "unread",
  extra,
  hoverIcon,
}: {
  id: FolderId;
  icon?: typeof Inbox;
  label: React.ReactNode;
  count?: number;
  countKind?: "unread" | "total" | "alert";
  extra?: React.ReactNode;
  hoverIcon?: React.ReactNode;
}) {
  const { folder, setFolder } = useMailroom();
  const on = folder === id;
  return (
    <button
      type="button"
      onClick={() => setFolder(id)}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors touch:py-2.5",
        on ? "tool-active font-medium" : "text-foreground/80 hover:bg-muted hover:text-foreground",
      )}
    >
      {Icon && <Icon className={cn("size-4 shrink-0", !on && "text-muted-foreground")} />}
      <span className={cn("min-w-0 flex-1", typeof label === "string" && "truncate")}>{label}</span>
      {extra}
      {(!!count || hoverIcon) && (
        <span className="grid shrink-0 items-center justify-items-end">
          {!!count && (
            <span
              className={cn(
                "col-start-1 row-start-1 text-xs tabular-nums",
                countKind === "unread" && "font-semibold text-primary",
                countKind === "alert" && "rounded-full bg-amber-500 px-1.5 py-px font-semibold text-white",
                countKind === "total" && "text-muted-foreground",
                hoverIcon && "group-hover:opacity-0",
              )}
            >
              {count}
            </span>
          )}
          {hoverIcon && (
            <span aria-hidden="true" className="col-start-1 row-start-1 opacity-0 group-hover:opacity-100">
              {hoverIcon}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-2">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1 px-1 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

export function FolderPane() {
  const { threads, ms, openHumanIds, agents, snap, events, startCompose, savedDraft, setSummonOpen, setNavOpen } = useMailroom();
  useNow(1000);
  const ctx = useMemo(() => ({ ms, openHuman: openHumanIds, agents }), [ms, openHumanIds, agents]);

  const counts = useMemo(() => {
    const unreadIn = (f: FolderId) =>
      threads.filter((t) => threadInFolder(t, f, ctx)).reduce((n, t) => n + t.events.filter(ms.isUnread).length, 0);
    const totalIn = (f: FolderId) => threads.filter((t) => threadInFolder(t, f, ctx)).length;
    const attention = threads.filter((t) => threadInFolder(t, "tasks", ctx)
      && t.goalTask && (t.goalTask.state === "blocked" || (t.goalTask.state !== "done" && t.goalTask.decision))).length;
    return {
      inbox: unreadIn("inbox"),
      needs: openHumanIds.size,
      flagged: totalIn("flagged"),
      sent: totalIn("sent"),
      all: unreadIn("all"),
      tasks: attention,
      archive: totalIn("archive"),
      deleted: totalIn("deleted"),
      status: events.filter((e) => e.type === "agent.status").length,
    };
  }, [threads, ctx, ms, openHumanIds, events]);

  const registry = snap?.agents ?? [];
  const team = registry.filter((a) => (a.kind ?? "permanent") === "permanent" && !a.id.includes("."));
  const liveTemps = registry.filter((a) => a.kind === "temporary" && !["expired", "stopped", "finished", "failed"].includes(a.state ?? "")).reverse();
  const unreadForAgent = (id: string) =>
    threads
      .filter((t) => threadInFolder(t, `agent:${id}`, ctx))
      .reduce((n, t) => n + t.events.filter((e) => ms.isUnread(e) && (e.from === id || e.to === id || (e.cc ?? []).includes(id))).length, 0);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="space-y-2 p-3">
        <Button className="w-full justify-start" onClick={() => (setNavOpen(false), startCompose("new"))}>
          <Send className="size-4" /> {savedDraft ? "Resume draft" : "New message"}
        </Button>
        <Button variant="outline" className="w-full justify-start" onClick={() => (setNavOpen(false), setSummonOpen(true))}>
          <Timer className="size-4" /> Summon agent
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        <Section title="Favorites">
          <FolderRow id="inbox" icon={Inbox} label="Inbox" count={counts.inbox} />
          <FolderRow id="needs" icon={AlertTriangle} label="Needs you" count={counts.needs} countKind="alert" />
          <FolderRow id="flagged" icon={Flag} label="Flagged" count={counts.flagged} countKind="total" />
          <FolderRow id="sent" icon={Send} label="Sent items" count={counts.sent} countKind="total" />
        </Section>
        <Section title="Command center">
          <FolderRow id="all" icon={MessagesSquare} label="All conversations" count={counts.all} />
          <FolderRow id="tasks" icon={ListTodo} label="Task mail" count={counts.tasks} countKind="alert" />
          <FolderRow id="status" icon={Activity} label="Status feed" count={counts.status} countKind="total" />
          <FolderRow id="archive" icon={Archive} label="Archive" count={counts.archive} countKind="total" />
          <FolderRow id="deleted" icon={Trash2} label="Deleted items" count={counts.deleted} countKind="total" />
        </Section>
        <Section title="Team">
          {team.map((a) => (
            <FolderRow
              key={a.id}
              id={`agent:${a.id}`}
              label={
                <span className={cn("flex items-center gap-2", a.retired && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                  <AgentAvatar id={a.id} agent={a} size="sm" showState />
                  <span className="truncate">
                    {a.id} <span className="text-muted-foreground">· {a.name}</span>
                  </span>
                </span>
              }
              count={unreadForAgent(a.id)}
              hoverIcon={<CliIcon cli={a.cli} className="text-muted-foreground" />}
            />
          ))}
        </Section>
        {liveTemps.length > 0 && (
          <Section title={`Temporary agents (${liveTemps.length})`} defaultOpen>
            {liveTemps.map((a) => (
              <FolderRow
                key={a.id}
                id={`agent:${a.id}`}
                label={
                  <span className="flex items-center gap-2">
                    <AgentAvatar id={a.id} agent={a} size="sm" showState />
                    <span className="truncate">
                      {a.id} <span className="text-muted-foreground">· {a.name}</span>
                    </span>
                  </span>
                }
                count={unreadForAgent(a.id)}
                hoverIcon={<CliIcon cli={a.cli} className="text-muted-foreground" />}
                extra={
                  <span className="font-mono text-[11px] tabular-nums text-sky-600 dark:text-sky-300">
                    {countdown(a.expires_at)}
                  </span>
                }
              />
            ))}
          </Section>
        )}
      </ScrollArea>
    </div>
  );
}
