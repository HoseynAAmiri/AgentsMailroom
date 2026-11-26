"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, CheckCheck, Flag, Mail, MailOpen, Menu, Paperclip, Pin, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { matchSnippet, messageHits, sortFolderThreads, TASK_FILTERS, threadInFolder, threadMatches, visibleEvents, snippet, type Thread } from "@/lib/threads";
import { GOAL_STATE_STYLE, listTime, plainTaskTitle } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar, Highlight, Pill } from "./bits";
import { useMailroom } from "./context";
import { MAIL_THREAD_LIST_HEADER_CLS } from "./page-skeletons";

const PAGE = 60;

export function folderTitle(folder: string, agentName?: string): string {
  const titles: Record<string, string> = {
    inbox: "Inbox",
    needs: "Needs you",
    flagged: "Flagged",
    sent: "Sent items",
    all: "All conversations",
    tasks: "Task mail",
    status: "Status feed",
    archive: "Archive",
    deleted: "Deleted items",
  };
  if (folder.startsWith("agent:")) return agentName ? `${folder.slice(6)} · ${agentName}` : folder.slice(6);
  return titles[folder] ?? folder;
}

export function useFolderThreads(): Thread[] {
  const { threads, folder, ms, openHumanIds, search, agents, taskFilter } = useMailroom();
  return useMemo(() => {
    const ctx = { ms, openHuman: openHumanIds, agents };
    let list = threads.filter((t) => threadInFolder(t, folder, ctx));
    if (folder === "tasks") {
      const f = TASK_FILTERS.find((x) => x.key === taskFilter) ?? TASK_FILTERS[0];
      list = list.filter(f.match);
    }
    const q = search.trim();
    if (q) list = list.filter((t) => threadMatches(t, q, agents));
    return sortFolderThreads(list, folder, ms);
  }, [threads, folder, ms, openHumanIds, search, agents, taskFilter]);
}

function participantsLine(t: Thread, evs: ReturnType<typeof visibleEvents>) {
  const last = evs[evs.length - 1] ?? t.events[t.events.length - 1];
  const to = [last.to, ...(last.cc ?? [])].filter(Boolean).join(", ");
  return `${last.from === "user" ? "You" : last.from} → ${to === "user" ? "You" : to.replace(/\buser\b/, "You")}`;
}

function ThreadRow({ t }: { t: Thread }) {
  const { folder, ms, selected, select, mark, openHumanIds, search } = useMailroom();
  const evs = visibleEvents(t, folder, ms);
  const last = evs[evs.length - 1];
  if (!last) return null;
  const query = search.trim();
  const hits = query ? messageHits(evs, query) : [];
  const preview = hits.at(-1) ?? last;
  const unread = evs.filter(ms.isUnread).length;
  const flagged = evs.some(ms.isFlagged);
  const needs = evs.some((e) => openHumanIds.has(e.id));
  const hasFiles = evs.some((e) => (e.refs ?? []).some((r) => r.kind === "file"));
  const sel = selected === t.key;
  const ids = evs.map((e) => e.id);
  const taskStyle = t.goalTask ? GOAL_STATE_STYLE[t.goalTask.state] : null;
  const taskTitle = t.goalTask ? plainTaskTitle(t.goalTask.title) : t.subject;
  const title = folder === "tasks" && t.taskId && taskTitle !== t.taskId ? `${t.taskId} · ${taskTitle}` : t.subject;
  const deletedView = folder === "deleted";
  const pinned = !deletedView && ms.isPinned(t.key);
  const participants = participantsLine(t, evs);

  return (
    <div
      role="button"
      tabIndex={0}
      data-thread={t.key}
      onClick={() => select(t.key, { focus: hits.at(-1)?.id ?? null })}
      onKeyDown={(e) => e.key === "Enter" && select(t.key, { focus: hits.at(-1)?.id ?? null })}
      className={cn(
        "group relative flex cursor-pointer gap-3 rounded-lg border-b border-l-[3px] border-l-transparent px-3 py-2.5 outline-none transition-colors touch:py-3",
        sel ? "tool-active" : cn("hover:bg-muted/60 active:bg-muted", pinned && "bg-amber-500/[0.04] dark:bg-amber-400/[0.06]"),
        unread > 0 && "border-l-primary",
        "focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      <AgentAvatar id={preview.from} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-semibold" : "text-foreground/90")}>{participants}</span>
          <span className={cn("shrink-0 text-xs tabular-nums [@media(hover:hover)]:group-hover:invisible group-focus-within:invisible", unread ? "font-semibold text-primary" : "text-muted-foreground")}>
            {listTime(preview.ts)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          {needs && <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />}
          <span className={cn("min-w-0 truncate text-sm", unread ? "font-semibold text-primary" : "text-foreground")} title={title}>
            {query ? <Highlight text={title} query={query} /> : title}
          </span>
          {hits.length > 0 ? (
            <span className="shrink-0 rounded bg-amber-300/80 px-1 text-[11px] font-medium text-foreground dark:bg-amber-400/40">
              {hits.length} {hits.length === 1 ? "match" : "matches"}
            </span>
          ) : evs.length > 1 && <span className="shrink-0 text-xs text-muted-foreground">({evs.length})</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {hasFiles && <Paperclip className="size-3.5 text-muted-foreground" />}
            {pinned && <Pin aria-hidden="true" className="size-3.5 fill-amber-500 text-amber-500" />}
            {flagged && <Flag className="size-3.5 fill-red-500 text-red-500" />}
            {taskStyle && <Pill className={taskStyle.cls}>{t.goalTask?.decision ? "USER decision" : taskStyle.label}</Pill>}
            {folder === "tasks" && !t.goalTask && <Pill className="bg-muted text-muted-foreground">Unlinked</Pill>}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {hits.length ? <Highlight text={matchSnippet(preview.body, query)} query={query} /> : snippet(last.body, 220)}
        </p>
      </div>
      <div className="absolute top-1 right-2 hidden items-center gap-0.5 rounded-lg border bg-background/95 p-0.5 shadow-xs [@media(hover:hover)]:group-hover:flex group-focus-within:flex">
        {deletedView ? (
          <QuickAction label="Restore" onClick={() => mark("restore", ids)} icon={RotateCcw} />
        ) : (
          <>
            <QuickAction label="Delete" onClick={() => mark("delete", ids)} icon={Trash2} />
            <QuickAction
              label={unread ? "Mark as read" : "Mark as unread"}
              onClick={() => (unread ? mark("read", ids) : mark("unread", [last.id]))}
              icon={unread ? MailOpen : Mail}
            />
            <QuickAction label={flagged ? "Clear flag" : "Flag"} onClick={() => (flagged ? mark("unflag", ids) : mark("flag", [last.id]))} icon={Flag} />
            <QuickAction
              label={pinned ? "Unpin" : "Pin"}
              ariaLabel={`Pin conversation: ${title}`}
              pressed={pinned}
              active={pinned}
              onClick={() => mark(pinned ? "unpin" : "pin", [t.key])}
              icon={Pin}
            />
          </>
        )}
      </div>
    </div>
  );
}

function QuickAction({
  label,
  ariaLabel,
  pressed,
  active,
  onClick,
  icon: Icon,
}: {
  label: string;
  ariaLabel?: string;
  pressed?: boolean;
  active?: boolean;
  onClick: () => void;
  icon: typeof Trash2;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={ariaLabel ?? label}
            aria-pressed={pressed}
            className={cn(active && "text-amber-600 dark:text-amber-400 [&_svg]:fill-current")}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          />
        }
      >
        <Icon aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ArchiveOlder() {
  const { threads, ms, openHumanIds, mark } = useMailroom();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(30);
  const cutoff = Date.now() - days * 86_400_000;
  const candidates = open ? threads.flatMap((thread) => {
    if (ms.isPinned(thread.key)) return [];
    if (thread.goalTask ? thread.goalTask.state !== "done" : thread.taskId && thread.task?.state !== "completed") return [];
    const live = visibleEvents(thread, "all", ms);
    const latest = live.at(-1);
    if (!latest || !(Date.parse(latest.ts) < cutoff) || live.every(ms.isArchived)) return [];
    return live.some((e) => ms.isUnread(e) || ms.isFlagged(e) || openHumanIds.has(e.id)) ? [] : [live];
  }) : [];

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<AlertDialogTrigger render={<Button variant="ghost" size="icon-sm" className="touch:size-8" aria-label="Archive older conversations" />} />}>
          <Archive />
        </TooltipTrigger>
        <TooltipContent>Archive older conversations</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive older conversations</AlertDialogTitle>
          <AlertDialogDescription>
            Move read conversations to Archive. Flagged or pinned conversations, unfinished tasks, and requests awaiting you stay in place.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span>Last activity</span>
          <SearchableSelect compact label="Last activity" value={String(days)} onChange={(value) => setDays(Number(value))}
            options={[30, 90, 180].map((n) => ({ value: String(n), label: `Over ${n} days ago` }))} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!candidates.length} onClick={() => {
            void mark("archive", candidates.flatMap((events) => events.map((e) => e.id)));
            setOpen(false);
          }}>
            Archive {candidates.length} {candidates.length === 1 ? "conversation" : "conversations"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ThreadList() {
  const { folder, agents, ms, mark, selected, select, taskFilter, setTaskFilter, setNavOpen, snap, search } = useMailroom();
  const list = useFolderThreads();
  const [limit, setLimit] = useState(PAGE);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLimit(PAGE), [folder]);

  const filtered = unreadOnly ? list.filter((t) => t.events.some(ms.isUnread)) : list;
  const shown = filtered.slice(0, limit);
  const unreadTotal = list.reduce((n, t) => n + t.events.filter(ms.isUnread).length, 0);
  const showPinnedSections = folder !== "deleted" && shown.some((t) => ms.isPinned(t.key));
  const pinnedShown = showPinnedSections ? shown.filter((t) => ms.isPinned(t.key)) : [];
  const unpinnedShown = showPinnedSections ? shown.filter((t) => !ms.isPinned(t.key)) : shown;
  const pinnedTotal = showPinnedSections ? filtered.filter((t) => ms.isPinned(t.key)).length : 0;

  useEffect(() => {
    if (!selected) return;
    scrollRef.current?.querySelector(`[data-thread="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "j" && e.key !== "k" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(e.target as HTMLElement)?.closest?.("[data-thread]")) return;
      e.preventDefault();
      const idx = shown.findIndex((t) => t.key === selected);
      const next = e.key === "j" || e.key === "ArrowDown" ? Math.min(shown.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (shown[next]) {
        const visible = visibleEvents(shown[next], folder, ms);
        const hits = search.trim() ? messageHits(visible, search) : [];
        select(shown[next].key, { focus: hits.at(-1)?.id ?? null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selected, select, folder, ms, search]);

  const agentName = folder.startsWith("agent:") ? agents.get(folder.slice(6))?.name : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className={MAIL_THREAD_LIST_HEADER_CLS}>
        <Button variant="ghost" size="icon-sm" aria-label="Folders" className="-ml-1 lg:hidden touch:size-8" onClick={() => setNavOpen(true)}>
          <Menu />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{folderTitle(folder, agentName)}</h2>
        {folder === "all" && snap?.capabilities?.admin && <ArchiveOlder />}
        <div className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5" role="tablist" aria-label="Show">
          {([false, true] as const).map((u) => (
            <button
              key={String(u)}
              type="button"
              role="tab"
              aria-selected={unreadOnly === u}
              onClick={() => setUnreadOnly(u)}
              className={cn(
                "inline-flex h-6 items-center rounded-md px-1.5 text-xs font-semibold transition-colors sm:px-2 touch:h-7",
                unreadOnly === u ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {u ? "Unread" : "All"}
            </button>
          ))}
        </div>
        {unreadTotal > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Mark all as read"
                  className="touch:size-8"
                  onClick={() => mark("read", list.flatMap((t) => t.events.filter(ms.isUnread).map((e) => e.id)))}
                />
              }
            >
              <CheckCheck />
            </TooltipTrigger>
            <TooltipContent>Mark all read</TooltipContent>
          </Tooltip>
        )}
      </div>
      {folder === "tasks" && (
        <div className="flex flex-wrap gap-1 border-b px-3 py-1.5 sm:py-2">
          {TASK_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setTaskFilter(f.key)}
              aria-pressed={taskFilter === f.key}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs",
                taskFilter === f.key ? "tool-active border-transparent" : "hover:bg-muted",
              )}
            >
              {f.label}
            </button>
          ))}
          <p className="mt-1 w-full text-xs text-muted-foreground">Tagged conversations. Linked tasks use the status in Goals.</p>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1" ref={scrollRef}>
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
            <MailOpen className="size-10 opacity-40" />
            {folder === "inbox" ? "All caught up." : folder === "tasks" ? "No task conversations match this filter." : "Nothing here."}
          </div>
        ) : showPinnedSections ? (
          <>
            <div className="flex items-center gap-1.5 border-b bg-amber-500/[0.05] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              <Pin aria-hidden="true" className="size-3" />
              <span>Pinned · {pinnedTotal}</span>
            </div>
            {pinnedShown.map((t) => <ThreadRow key={t.key} t={t} />)}
            {unpinnedShown.length > 0 && (
              <>
                <div className="border-b bg-muted/30 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Conversations
                </div>
                {unpinnedShown.map((t) => <ThreadRow key={t.key} t={t} />)}
              </>
            )}
          </>
        ) : (
          shown.map((t) => <ThreadRow key={t.key} t={t} />)
        )}
        {filtered.length > limit && (
          <div className="p-3">
            <Button variant="ghost" className="w-full" onClick={() => setLimit(limit + PAGE)}>
              Show {Math.min(PAGE, filtered.length - limit)} more of {filtered.length - limit}
            </Button>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
