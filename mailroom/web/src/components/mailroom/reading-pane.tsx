"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, ChevronsUpDown, Flag, Forward, Mail, MailOpen, MoreHorizontal, Reply, ReplyAll, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { visibleEvents } from "@/lib/threads";
import { fullTime, listTime, TASK_STATE_STYLE, TYPE_STYLE } from "@/lib/format";
import type { BusEvent } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AgentAvatar, Pill, RefChip, RichText, Tip } from "./bits";
import { Composer } from "./composer";
import { useMailroom } from "./context";

function IconAction({ label, icon: Icon, onClick, className }: { label: string; icon: typeof Reply; onClick: () => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className={className} />}>
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Recipients({ e }: { e: BusEvent }) {
  const { agents } = useMailroom();
  const name = (id: string) => (id === "user" ? "You" : agents.get(id)?.name && agents.get(id)!.name !== id ? `${id} (${agents.get(id)!.name})` : id);
  return (
    <div className="truncate text-xs text-muted-foreground">
      To: <span className="text-foreground/80">{e.to === "*" ? "everyone" : name(e.to)}</span>
      {e.cc?.length ? (
        <>
          {"  ·  "}Cc: <span className="text-foreground/80">{e.cc.map(name).join(", ")}</span>
        </>
      ) : null}
    </div>
  );
}

function MessageCard({ e, expanded, onToggle, focused }: { e: BusEvent; expanded: boolean; onToggle: () => void; focused: boolean }) {
  const { agents, ms, mark, startCompose, openHumanIds } = useMailroom();
  const deleted = ms.isDeleted(e);
  const flagged = ms.isFlagged(e);
  const unread = ms.isUnread(e);
  const type = TYPE_STYLE[e.type] ?? TYPE_STYLE.message;
  const sender = e.from === "user" ? "You" : agents.get(e.from)?.name ?? e.from;
  const needs = openHumanIds.has(e.id);

  return (
    <article
      id={`msg-${e.id}`}
      className={cn(
        "rounded-lg border bg-card transition-shadow",
        focused && "ring-2 ring-primary/60",
        needs && "border-amber-300 dark:border-amber-800",
        unread && "border-l-[3px] border-l-primary",
      )}
    >
      <header className="flex cursor-pointer items-start gap-3 px-3 py-3 sm:px-4" onClick={onToggle}>
        <AgentAvatar id={e.from} agent={agents.get(e.from)} showState={e.from !== "user"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-sm", unread ? "font-bold" : "font-semibold")}>{sender}</span>
            {e.from !== "user" && <span className="text-xs text-muted-foreground">{e.from}</span>}
            {e.type !== "message" && <Pill className={type.cls}>{type.label}</Pill>}
            {flagged && <Flag className="size-3.5 fill-red-500 text-red-500" />}
            <Tip label={fullTime(e.ts)} side="top" className="ml-auto shrink-0">
              <span className="text-xs text-muted-foreground">{listTime(e.ts)}</span>
            </Tip>
          </div>
          {expanded ? <Recipients e={e} /> : <p className="truncate text-xs text-muted-foreground">{e.body.replace(/\s+/g, " ")}</p>}
        </div>
      </header>
      {expanded && (
        <>
          <div className="px-3 pb-3 sm:px-4 sm:pl-[60px]">
            {needs && (
              <div className="mb-3 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                <AlertTriangle className="size-4 shrink-0" /> {e.from} is waiting for your decision.
              </div>
            )}
            <RichText text={e.body} />
            {(e.refs ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(e.refs ?? []).map((r, i) => (
                  <RefChip key={i} r={r} />
                ))}
              </div>
            )}
          </div>
          <footer className="flex items-center gap-0.5 border-t px-1.5 py-1.5 sm:gap-1 sm:px-3 sm:pl-[56px]">
            <Button variant="ghost" size="sm" aria-label="Reply" onClick={() => startCompose("reply", e)}>
              <Reply /> <span className="hidden sm:inline">Reply</span>
            </Button>
            <Button variant="ghost" size="sm" aria-label="Reply all" onClick={() => startCompose("replyAll", e)}>
              <ReplyAll /> <span className="hidden sm:inline">Reply all</span>
            </Button>
            <Button variant="ghost" size="sm" aria-label="Forward" onClick={() => startCompose("forward", e)}>
              <Forward /> <span className="hidden sm:inline">Forward</span>
            </Button>
            <Tip label={`${e.ts}${e.task_id ? ` · ${e.task_id}` : ""}`} side="top" className="ml-auto min-w-0 truncate">
              <span className="font-mono text-[11px] text-muted-foreground">
                {e.id}
                {e.task_id ? ` · ${e.task_id}` : ""}
              </span>
            </Tip>
            <IconAction label={flagged ? "Clear flag" : "Flag"} icon={Flag} onClick={() => mark(flagged ? "unflag" : "flag", [e.id])} className={cn(flagged && "text-red-500")} />
            <IconAction label={unread ? "Mark as read" : "Mark as unread"} icon={unread ? MailOpen : Mail} onClick={() => mark(unread ? "read" : "unread", [e.id])} />
            {deleted ? (
              <IconAction label="Restore" icon={RotateCcw} onClick={() => mark("restore", [e.id])} />
            ) : (
              <IconAction label="Delete message" icon={Trash2} onClick={() => mark("delete", [e.id])} />
            )}
          </footer>
        </>
      )}
    </article>
  );
}

function EmptyReading() {
  const { openHuman, agents, openEvent, threads, ms } = useMailroom();
  const unread = threads.reduce((n, t) => n + t.events.filter(ms.isUnread).length, 0);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl border border-sky-500/30 bg-sky-500/10 text-sky-500">
        <Mail className="size-8" />
      </div>
      <div>
        <p className="text-lg font-semibold">Select a conversation to read</p>
        <p className="text-sm text-muted-foreground">
          {unread ? `${unread} unread` : "Nothing unread."} <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd> move ·{" "}
          <kbd className="rounded border px-1">r</kbd> reply
        </p>
      </div>
      {openHuman.length > 0 && (
        <div className="w-full max-w-md space-y-2 text-left">
          <p className="text-xs font-semibold tracking-wide text-amber-600 uppercase">Waiting for you</p>
          {openHuman.slice(-5).map((e) => (
            <button key={e.id} type="button" onClick={() => openEvent(e.id)} className="flex w-full items-start gap-2 rounded-md border p-2 text-left hover:bg-muted">
              <AgentAvatar id={e.from} size="sm" />
              <span className="min-w-0 text-sm">
                <span className="font-medium">{agents.get(e.from)?.name ?? e.from}</span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{e.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReadingPane() {
  const { threads, selected, select, folder, ms, mark, compose, startCompose, focusEvent, agents, snap } = useMailroom();
  const thread = useMemo(() => threads.find((t) => t.key === selected) ?? null, [threads, selected]);
  const evs = useMemo(() => (thread ? visibleEvents(thread, folder, ms) : []), [thread, folder, ms]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [olderPages, setOlderPages] = useState(0);
  const [laterPages, setLaterPages] = useState(0);

  useEffect(() => {
    if (!thread) return;
    const v = visibleEvents(thread, folder, ms);
    const open = new Set(v.slice(-2).map((e) => e.id));
    v.filter(ms.isUnread).forEach((e) => open.add(e.id));
    if (focusEvent) open.add(focusEvent);
    setExpanded(open);
    setOlderPages(0);
    setLaterPages(0);
    // only when the conversation changes, not on every poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.key, focusEvent]);

  useEffect(() => {
    if (focusEvent) setTimeout(() => document.getElementById(`msg-${focusEvent}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
  }, [focusEvent, thread?.key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !evs.length) return;
      const last = evs[evs.length - 1];
      if (e.key === "r") startCompose("reply", last);
      else if (e.key === "R") startCompose("replyAll", last);
      else if (e.key === "f") startCompose("forward", last);
      else if (e.key === "Delete" || e.key === "#") mark(folder === "deleted" ? "restore" : "delete", evs.map((x) => x.id));
      else if (e.key === "u") mark("unread", [last.id]);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evs, startCompose, mark, folder]);

  if (compose && (compose.mode === "new" || !thread || compose.threadKey !== thread.key || !evs.length)) {
    return <Composer />;
  }
  if (!thread || !evs.length) return <EmptyReading />;

  const last = evs[evs.length - 1];
  const ids = evs.map((e) => e.id);
  const flagged = evs.some(ms.isFlagged);
  const deletedView = folder === "deleted";
  const archived = evs.every(ms.isArchived);
  const taskStyle = thread.task ? TASK_STATE_STYLE[thread.task.state] : null;
  const focusIndex = focusEvent ? evs.findIndex((e) => e.id === focusEvent) : -1;
  const initialStart = focusIndex >= 0 && focusIndex < evs.length - 6 ? Math.max(0, focusIndex - 3) : Math.max(0, evs.length - 6);
  const start = Math.max(0, initialStart - olderPages * 30);
  const end = Math.min(evs.length, initialStart + 6 + laterPages * 30);
  const shown = evs.slice(start, end);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b px-1.5 py-1.5 sm:px-3">
        <Button variant="ghost" size="icon-sm" aria-label="Back to list" className="md:hidden" onClick={() => select(null)}>
          <ArrowLeft />
        </Button>
        <IconAction label="Reply" icon={Reply} onClick={() => startCompose("reply", last)} />
        <IconAction label="Reply all" icon={ReplyAll} onClick={() => startCompose("replyAll", last)} />
        <IconAction label="Forward" icon={Forward} onClick={() => startCompose("forward", last)} />
        <div className="mx-1 h-5 w-px bg-border" />
        {!deletedView && snap?.capabilities?.admin && (
          <IconAction label={archived ? "Unarchive conversation" : "Archive conversation"} icon={archived ? ArchiveRestore : Archive}
            onClick={() => void mark(archived ? "unarchive" : "archive", ids)} />
        )}
        {deletedView ? (
          <IconAction label="Restore" icon={RotateCcw} onClick={() => (mark("restore", ids), select(null))} />
        ) : (
          <IconAction label="Delete" icon={Trash2} onClick={() => (mark("delete", ids), select(null))} />
        )}
        <IconAction label={flagged ? "Unflag" : "Flag"} icon={Flag} onClick={() => mark(flagged ? "unflag" : "flag", flagged ? ids : [last.id])} className={cn(flagged && "fill-red-500 text-red-500")} />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" className="ml-auto" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => mark("unread", [last.id])}>
              <Mail /> Mark as unread
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => mark("read", ids)}>
              <MailOpen /> Mark all as read
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setExpanded(new Set(shown.map((e) => e.id)))}>
              <ChevronsUpDown /> Expand visible messages
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setExpanded(new Set())}>
              <ChevronsUpDown /> Collapse messages
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-3 p-3 sm:p-5">
          <div>
            <h1 className="text-lg leading-tight font-semibold break-words sm:text-xl">{thread.subject}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {thread.taskId && <Pill className="bg-muted font-mono text-muted-foreground">{thread.taskId}</Pill>}
              {taskStyle && <Pill className={taskStyle.cls}>{taskStyle.label}</Pill>}
              {thread.task?.parent_task_id && <Pill className="bg-muted text-muted-foreground">↳ {thread.task.parent_task_id}</Pill>}
              <span className="text-xs text-muted-foreground">
                {evs.length} message{evs.length === 1 ? "" : "s"} ·
              </span>
              <div className="flex -space-x-1.5">
                {thread.participants.slice(0, 8).map((p) => (
                  <span key={p} title={p === "user" ? "You" : `${p} · ${agents.get(p)?.name ?? ""}`}>
                    <AgentAvatar id={p} size="sm" />
                  </span>
                ))}
              </div>
            </div>
          </div>
          {start > 0 && (
            <button type="button" onClick={() => setOlderPages((n) => n + 1)} className="w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground hover:bg-muted">
              Load earlier messages ({start})
            </button>
          )}
          {shown.map((e) => (
            <MessageCard
              key={e.id}
              e={e}
              focused={e.id === focusEvent}
              expanded={expanded.has(e.id)}
              onToggle={() =>
                setExpanded((s) => {
                  const n = new Set(s);
                  if (n.has(e.id)) n.delete(e.id);
                  else n.add(e.id);
                  return n;
                })
              }
            />
          ))}
          {end < evs.length && (
            <button type="button" onClick={() => setLaterPages((n) => n + 1)} className="w-full rounded-md border border-dashed py-2 text-xs text-muted-foreground hover:bg-muted">
              Load newer messages ({evs.length - end})
            </button>
          )}
          {compose && compose.threadKey === thread.key ? <Composer inline /> : null}
        </div>
      </ScrollArea>
    </div>
  );
}
