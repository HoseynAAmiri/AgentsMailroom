"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, ArchiveRestore, ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, ChevronsUpDown, Flag, Forward, Mail, MailOpen, MoreHorizontal, Pin, Reply, ReplyAll, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { eventTaskId, matchSnippet, messageHits, visibleEvents } from "@/lib/threads";
import { needsPreview } from "@/lib/resolve-human";
import { fullTime, GOAL_STATE_STYLE, listTime, plainTaskTitle, TYPE_STYLE } from "@/lib/format";
import type { BusEvent } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AgentAvatar, Highlight, Pill, RefChip, RichText, Tip } from "./bits";
import { Composer } from "./composer";
import { useMailroom } from "./context";
import { MAIL_READING_TOOLBAR_CLS } from "./page-skeletons";

function IconAction({
  label,
  ariaLabel,
  pressed,
  icon: Icon,
  onClick,
  className,
}: {
  label: string;
  ariaLabel?: string;
  pressed?: boolean;
  icon: typeof Reply;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={ariaLabel ?? label} aria-pressed={pressed} onClick={onClick} className={cn("touch:size-9", className)} />}>
        <Icon aria-hidden="true" />
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

function MessageCard({ e, expanded, onToggle, focused, query }: { e: BusEvent; expanded: boolean; onToggle: () => void; focused: boolean; query: string }) {
  const { agents, ms, mark, startCompose, openHumanIds, clickResolutions, promptResolve, taskTags } = useMailroom();
  const taskTag = eventTaskId(e, taskTags);
  const deleted = ms.isDeleted(e);
  const flagged = ms.isFlagged(e);
  const unread = ms.isUnread(e);
  const needs = openHumanIds.has(e.id);
  const resolution = clickResolutions.get(e.id) ?? null;
  const type = e.type === "human.needed" && !needs && resolution
    ? TYPE_STYLE["human.resolved"]
    : (TYPE_STYLE[e.type] ?? TYPE_STYLE.message);
  const sender = e.from === "user" ? "You" : agents.get(e.from)?.name ?? e.from;
  const needle = query.trim().toLowerCase();
  const hit = !!needle && (e.id.toLowerCase() === needle || e.body.toLowerCase().includes(needle));

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
          {expanded ? <Recipients e={e} /> : (
            <p className="truncate text-xs text-muted-foreground">
              <Highlight text={hit ? matchSnippet(e.body, query, 240) : needsPreview(e, 160)} query={hit ? query : ""} />
            </p>
          )}
        </div>
      </header>
      {expanded && (
        <>
          <div className="px-3 pb-3 sm:px-4 sm:pl-[60px]">
            {needs && !deleted && (
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
                <span className="flex min-w-0 items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                  <span>{e.from} is waiting for your decision.</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-mark-resolved={e.id}
                  onClick={() => promptResolve([e])}
                  className="border-amber-500/45 bg-background/85 text-amber-900 hover:bg-amber-500/15 dark:text-amber-100 touch:min-h-8"
                >
                  <CheckCircle2 aria-hidden="true" /> Mark resolved
                </Button>
              </div>
            )}
            {!needs && resolution && (
              <div
                data-click-resolution={e.id}
                className="mb-3 flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-800 dark:text-emerald-200"
              >
                <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="font-medium">Marked resolved</span>
                <span className="text-emerald-700/80 dark:text-emerald-300/80">· {fullTime(resolution.ts)}</span>
              </div>
            )}
            <RichText text={e.body} query={hit ? query : ""} />
            {(e.refs ?? []).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(e.refs ?? []).map((r, i) => (
                  <RefChip key={i} r={r} />
                ))}
              </div>
            )}
          </div>
          <footer className="flex flex-wrap items-center gap-0.5 border-t px-1.5 py-1.5 sm:gap-1 sm:px-3 sm:pl-[56px]">
            <Button variant="ghost" size="sm" aria-label="Reply" onClick={() => startCompose("reply", e)}>
              <Reply /> <span className="hidden sm:inline">Reply</span>
            </Button>
            <Button variant="ghost" size="sm" aria-label="Reply all" onClick={() => startCompose("replyAll", e)}>
              <ReplyAll /> <span className="hidden sm:inline">Reply all</span>
            </Button>
            <Button variant="ghost" size="sm" aria-label="Forward" onClick={() => startCompose("forward", e)}>
              <Forward /> <span className="hidden sm:inline">Forward</span>
            </Button>
            {needs && !deleted && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Mark resolved"
                onClick={() => promptResolve([e])}
                className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
              >
                <CheckCircle2 aria-hidden="true" /> <span className="hidden sm:inline">Mark resolved</span>
              </Button>
            )}
            <Tip label={`${e.ts}${taskTag ? ` · ${taskTag}` : ""}`} side="top" className="ml-auto min-w-0 truncate">
              <span className="font-mono text-[11px] text-muted-foreground">
                {e.id}
                {taskTag ? ` · ${taskTag}` : ""}
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
  const { openHuman, agents, openEvent, promptResolve, threads, ms } = useMailroom();
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
            <div key={e.id} className="flex items-center gap-2 rounded-md border p-2">
              <button type="button" onClick={() => openEvent(e.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded text-left hover:opacity-90">
                <AgentAvatar id={e.from} size="sm" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate font-medium">{agents.get(e.from)?.name ?? e.from}</span>
                  <span className="block truncate text-xs text-muted-foreground">{needsPreview(e, 120)}</span>
                </span>
              </button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={`Mark resolved: ${e.id}`}
                onClick={() => promptResolve([e])}
                className="shrink-0 touch:min-h-8"
              >
                <CheckCircle2 aria-hidden="true" /> Mark resolved
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReadingPane() {
  const { threads, selected, select, folder, ms, mark, compose, startCompose, focusEvent, agents, snap, openGoalTask, search, openHumanIds, promptResolve } = useMailroom();
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
    const q = search.trim();
    if (q) messageHits(v, q).forEach((e) => open.add(e.id));
    setExpanded(open);
    setOlderPages(0);
    setLaterPages(0);
    // only when the conversation, the focused message, or the search changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.key, focusEvent, search]);

  const prevSearchRef = useRef(search);

  useEffect(() => {
    const q = search.trim();
    const searchChanged = prevSearchRef.current !== search;
    prevSearchRef.current = search;
    if (!thread || !q) return;
    const found = messageHits(visibleEvents(thread, folder, ms), q);
    if (!found.length) return;
    // Preserve explicit event navigation (e.g. openEvent to a non-matching message) unless the query itself changed or no message is focused.
    if (focusEvent && (!searchChanged || found.some((e) => e.id === focusEvent))) return;
    select(thread.key, { focus: found[found.length - 1].id, markRead: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, thread?.key, focusEvent]);

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
  const openInThread = deletedView ? [] : evs.filter((e) => openHumanIds.has(e.id));
  const pinned = !deletedView && ms.isPinned(thread.key);
  const archived = evs.every(ms.isArchived);
  const goalTask = thread.goalTask;
  const taskStyle = goalTask ? GOAL_STATE_STYLE[goalTask.state] : null;
  const query = search.trim();
  const hits = query ? messageHits(evs, query) : [];
  const hitAt = focusEvent ? hits.findIndex((e) => e.id === focusEvent) : -1;
  const focusIndex = focusEvent ? evs.findIndex((e) => e.id === focusEvent) : -1;
  const hitIndices = hits.map((h) => evs.findIndex((e) => e.id === h.id));
  const prevHit = hitAt > 0
    ? hits[hitAt - 1]
    : hitAt < 0 && focusIndex >= 0
      ? (hits[hitIndices.filter((idx) => idx < focusIndex).length - 1] ?? null)
      : null;
  const nextHit = hitAt >= 0 && hitAt < hits.length - 1
    ? hits[hitAt + 1]
    : hitAt < 0
      ? (hits.find((_, k) => (focusIndex >= 0 ? hitIndices[k] > focusIndex : true)) ?? null)
      : null;
  const initialStart = focusIndex >= 0 && focusIndex < evs.length - 6 ? Math.max(0, focusIndex - 3) : Math.max(0, evs.length - 6);
  const start = Math.max(0, initialStart - olderPages * 30);
  const end = Math.min(evs.length, initialStart + 6 + laterPages * 30);
  const shown = evs.slice(start, end);

  return (
    <div className="flex h-full flex-col">
      <div className={MAIL_READING_TOOLBAR_CLS}>
        <Button variant="ghost" size="icon-sm" aria-label="Back to list" className="md:hidden touch:size-9" onClick={() => select(null)}>
          <ArrowLeft />
        </Button>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-0.5">
        <IconAction label="Reply" icon={Reply} onClick={() => startCompose("reply", last)} />
        <IconAction label="Reply all" icon={ReplyAll} onClick={() => startCompose("replyAll", last)} className="hidden sm:inline-flex" />
        <IconAction label="Forward" icon={Forward} onClick={() => startCompose("forward", last)} className="hidden sm:inline-flex" />
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
        {!deletedView && (
          <IconAction
            label={pinned ? "Unpin conversation" : "Pin conversation"}
            ariaLabel={`Pin conversation: ${thread.subject}`}
            pressed={pinned}
            icon={Pin}
            onClick={() => void mark(pinned ? "unpin" : "pin", [thread.key])}
            className={cn(pinned && "text-amber-600 dark:text-amber-400 [&_svg]:fill-current")}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="touch:size-9" aria-label="More" />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem className="sm:hidden" onClick={() => startCompose("replyAll", last)}>
              <ReplyAll /> Reply all
            </DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" onClick={() => startCompose("forward", last)}>
              <Forward /> Forward
            </DropdownMenuItem>
            <DropdownMenuSeparator className="sm:hidden" />
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
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-3 p-3 sm:p-5">
          <div>
            <h1 className="text-lg leading-tight font-semibold break-words sm:text-xl">{thread.subject}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {goalTask ? (
                <Button variant="outline" size="xs" onClick={() => openGoalTask(goalTask.id)} title={plainTaskTitle(goalTask.title)}>
                  Open {goalTask.id} in Goals
                </Button>
              ) : thread.taskId && <Pill className="bg-muted font-mono text-muted-foreground">{thread.taskId} · Unlinked</Pill>}
              {taskStyle && <Pill className={taskStyle.cls}>{goalTask?.decision ? "USER decision" : taskStyle.label}</Pill>}
              {openInThread.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => promptResolve(openInThread)}
                  className="border-amber-500/45 text-amber-800 hover:bg-amber-500/15 dark:text-amber-200 touch:min-h-8"
                >
                  <CheckCircle2 aria-hidden="true" /> Mark resolved
                </Button>
              )}
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
          {hits.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/80 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-800 dark:bg-amber-950/40">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{hits.length}</span> {hits.length === 1 ? "message contains" : "messages contain"} “{query}”
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={!prevHit}
                onClick={() => prevHit && select(thread.key, { focus: prevHit.id, markRead: false })}
              >
                <ChevronUp /> Earlier
              </Button>
              <span className="tabular-nums text-muted-foreground">
                {hitAt >= 0 ? `${hitAt + 1} of ${hits.length}` : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`}
              </span>
              <Button
                variant="outline"
                size="xs"
                disabled={!nextHit}
                onClick={() => nextHit && select(thread.key, { focus: nextHit.id, markRead: false })}
              >
                Later <ChevronDown />
              </Button>
            </div>
          )}
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
              query={query}
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
