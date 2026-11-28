"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { AlertTriangle, FolderOpen, ListTodo, Mail, Monitor, Moon, PenSquare, RefreshCw, Search, Sun, Users, X } from "lucide-react";
import { useTheme } from "next-themes";
import { applyThemeMeta } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { connection } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useCanHover, useIsMobile, useIsTablet } from "@/hooks/use-mobile";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HoverTip, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import dynamic from "next/dynamic";
import { FilesView } from "@/components/files/files-view";
import { FileViewer } from "@/components/viewer/file-viewer";
import { useBackLayer } from "@/hooks/use-back-layer";
import { useKeyboardViewport } from "@/hooks/use-keyboard-viewport";
import { MachineView, memLevel } from "@/components/machine/machine-view";
import { SummonDialog } from "@/components/team/summon-dialog";
import { TeamView } from "@/components/team/team-view";
import { MailroomProvider, useMailroom, type View } from "./context";
import { FolderPane } from "./folder-pane";
import { Composer } from "./composer";
import { ReadingPane } from "./reading-pane";
import { ResolveHumanDialog } from "./resolve-dialog";
import { StatusFeed } from "./status-feed";
import { ThreadList } from "./thread-list";
import { Tip } from "./bits";
import {
  Bone,
  FolderSidebarSkeleton,
  GoalsPageFallback,
  PageSkeleton,
  ReadingPaneSkeleton,
  StatusFeedSkeleton,
  ThreadListSkeleton,
  resolveMailSkeletonVariant,
} from "./page-skeletons";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function applyPaneLayout(groupId: string, layout: Record<string, number> | undefined) {
  if (!layout) return;
  const root = document.getElementById(groupId);
  if (!root) return;
  for (const [id, value] of Object.entries(layout)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const panel = document.getElementById(id);
    if (!panel || !root.contains(panel)) continue;
    panel.style.flexGrow = String(value);
    panel.style.flexShrink = "1";
    panel.style.flexBasis = "0px";
  }
}

const paneStorage = {
  getItem(key: string) {
    if (typeof window === "undefined") return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

const GoalsView = dynamic(
  () => import("@/components/goals/goals-view").then((module) => module.GoalsView),
  { loading: () => <GoalsPageFallback /> },
);
const GB_PER_GIB = 2 ** 30 / 1e9;

function Clock() {
  const [t, setT] = useState("--:--:--");
  useEffect(() => {
    const format = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const tick = () => setT(format.format(new Date()));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);
  return (
    <HoverTip label="Local time" side="bottom">
      <span className="inline-block w-[8ch] whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{t}</span>
    </HoverTip>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  useEffect(() => {
    if (resolvedTheme === "light" || resolvedTheme === "dark") applyThemeMeta(resolvedTheme);
  }, [resolvedTheme]);
  return (
    <HoverTip label={dark ? "Switch to Light Mode" : "Switch to Dark Mode"} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Theme"
        onClick={() => setTheme(dark ? "light" : "dark")}
        className="text-muted-foreground hover:text-foreground touch:size-9"
      >
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>
    </HoverTip>
  );
}

function TopBar() {
  const { connected, error, snap, search, setSearch, refreshActiveView, needsThreadCount, setFolder, view } = useMailroom();
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const mem = snap?.memory && "avail_gib" in snap.memory ? snap.memory : null;
  const freeGB = mem ? (mem.avail_gib * GB_PER_GIB).toFixed(1) : "";
  const totalGB = mem ? (mem.total_gib * GB_PER_GIB).toFixed(1) : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (e.key === "/" && !["input", "textarea"].includes(tag)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="relative z-30 flex min-h-11 shrink-0 items-center gap-1.5 border-b border-border bg-card/85 px-2 pt-[max(0.25rem,env(safe-area-inset-top))] pb-1 backdrop-blur-md sm:gap-2 sm:px-3 md:[--header-side:20.5rem] min-[900px]:grid min-[900px]:h-12 min-[900px]:min-h-0 min-[900px]:grid-cols-[minmax(var(--header-side),1fr)_minmax(0,36rem)_minmax(var(--header-side),1fr)] min-[900px]:pt-[env(safe-area-inset-top)] min-[900px]:pb-0 lg:[--header-side:23.5rem] xl:[--header-side:28rem]">
      <div className="flex shrink-0 items-center gap-2 min-[900px]:min-w-0 min-[900px]:gap-2.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-sky-500/30 bg-sky-500/15 text-sky-500">
          <Mail className="size-4" />
        </div>
        <div className="hidden min-w-0 leading-tight sm:block">
          <div className="truncate text-sm font-semibold tracking-tight">Command Center</div>
        </div>
      </div>
      <div className="relative min-w-0 flex-1 min-[900px]:flex-none">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={ref}
          aria-label="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (setSearch(""), ref.current?.blur())}
          placeholder={view === "files" ? "Search attachments" : view === "goals" ? "Search goals and tasks" : "Search mail, task ids, agents, e123"}
          className="h-8 bg-background/75 pr-8 pl-8 shadow-none touch:h-9"
        />
        {search && (
          <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-self-end gap-1 sm:gap-2">
        {needsThreadCount > 0 && (
          <Tip label={`${needsThreadCount} ${needsThreadCount === 1 ? "thread" : "threads"} waiting on you`} side="bottom">
            <button
              type="button"
              onClick={() => setFolder("needs")}
              aria-label="Waiting on you"
              className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 text-xs font-semibold tabular-nums text-amber-700 hover:bg-amber-500/25 dark:text-amber-300 sm:w-14 sm:px-0 touch:h-9"
            >
              <AlertTriangle className="size-3.5 shrink-0" /> {needsThreadCount > 99 ? "99+" : needsThreadCount}
            </button>
          </Tip>
        )}
        {mem && (
          <Tip label="Free memory on machine A" className="hidden md:inline-flex">
            <span
              aria-label={`${freeGB} of ${totalGB} GB free on machine A`}
              className={cn(
                "w-[18ch] shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-center font-mono text-xs tabular-nums",
                memLevel(mem.avail_gib) === "bad" ? "bg-rose-500/15 text-rose-600 dark:text-rose-300" : memLevel(mem.avail_gib) === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
            >
              {freeGB} / {totalGB} GB
            </span>
          </Tip>
        )}
        <Tip label={error ?? "Live · polls every 5 s"} className="inline-flex shrink-0 items-center gap-1.5">
          <span className="inline-flex w-2 items-center gap-1.5 text-xs lg:w-14">
            <span className={cn("size-2 shrink-0 rounded-full", connected ? "animate-pulse bg-sky-500" : "bg-rose-500")} />
            <span className={cn("sr-only font-medium lg:not-sr-only", connected ? "text-sky-600 dark:text-sky-300" : "text-rose-600 dark:text-rose-300")}>{connected ? "LIVE" : "Offline"}</span>
          </span>
        </Tip>
        <span className="hidden xl:inline">
          <Clock />
        </span>
        <HoverTip label="Refresh current view" side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label="Refresh current view"
            disabled={refreshing} className="text-muted-foreground hover:text-foreground touch:size-9" onClick={async () => {
              setRefreshing(true);
              try { await refreshActiveView(); }
              finally { setRefreshing(false); }
            }}>
            <RefreshCw className={refreshing ? "motion-safe:animate-spin" : ""} />
          </Button>
        </HoverTip>
        <ThemeToggle />
      </div>
    </header>
  );
}

function Rail() {
  const { view, setView, threads, ms, snap } = useMailroom();
  const canHover = useCanHover();
  const unread = threads.reduce((n, t) => n + t.events.filter(ms.isUnread).length, 0);
  const agents = (snap?.agents ?? []).filter((a) => !a.id.includes(".") && !a.retired);
  const notReading = agents.filter((a) => {
    const m = snap?.machines?.find((x) => x.id === (a.machine ?? "A"));
    const linkOk = !m || m.kind === "local" ? true : m.checked_at ? !!(m.reachable && m.bus_via_tunnel) : undefined;
    return ["backlog", "offline"].includes(connection(a, snap?.presence?.[a.id], true, linkOk).level);
  }).length;
  const items: { id: View; icon: typeof Mail; label: string; badge?: number; alert?: boolean }[] = [
    { id: "mail", icon: Mail, label: "Mail", badge: unread },
    { id: "goals", icon: ListTodo, label: "Goals" },
    { id: "team", icon: Users, label: "Team", badge: notReading, alert: true },
    { id: "machine", icon: Monitor, label: "Machines" },
    { id: "files", icon: FolderOpen, label: "Files" },
  ];
  return (
    <nav
      className="hide-on-kb order-last flex shrink-0 items-stretch justify-around border-t bg-sidebar px-1 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] md:order-first md:w-14 md:flex-col md:items-center md:justify-start md:gap-1 md:border-t-0 md:border-r md:bg-card/60 md:px-0 md:py-2"
      aria-label="Apps"
    >
      {items.map((it) => {
        const button = (
          <button
            key={it.id}
            type="button"
            onClick={() => setView(it.id)}
            aria-label={it.label}
            className={cn(
              "relative mx-0.5 flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1 text-[11px] font-medium transition-colors md:m-0 md:size-11 md:flex-none md:py-0 md:text-[10px]",
              view === it.id ? "tool-active" : "text-foreground/70 hover:bg-muted hover:text-foreground",
            )}
          >
            <it.icon className="size-[18px]" />
            {it.label}
            {!!it.badge && (
              <span
                className={cn(
                  "absolute top-0.5 left-1/2 ml-2 w-6 rounded-full text-center text-[10px] leading-4 font-semibold tabular-nums md:top-0 md:right-0 md:left-auto md:ml-0",
                  it.alert ? "bg-amber-500 text-white" : "bg-primary text-primary-foreground",
                )}
              >
                {it.badge > 99 ? "99+" : it.badge}
              </span>
            )}
          </button>
        );
        // Tooltips swallow the first tap on touch screens.
        if (!canHover) return button;
        return (
          <Tooltip key={it.id}>
            <TooltipTrigger render={button} />
            <TooltipContent side="right">{it.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/** Phones: the list stays mounted under the open conversation and the composer, so Back returns to
 *  the same scroll position. Replies are written full screen, sized to the space above the keyboard. */
function MobileMailView({ loading = false }: { loading?: boolean }) {
  const { folder, selected, compose, savedDraft, startCompose } = useMailroom();
  if (loading) {
    const isStatus = folder === "status";
    return (
      <div
        data-skeleton={isStatus ? "mail-status" : "mail"}
        data-skeleton-variant={resolveMailSkeletonVariant(folder)}
        role="status"
        aria-busy="true"
        aria-label="Loading mail"
        className="relative h-full"
      >
        <div className="h-full">
          {isStatus ? <StatusFeedSkeleton /> : <ThreadListSkeleton folder={folder} />}
        </div>
        {!isStatus && !compose && <Bone className="pointer-events-none absolute right-4 bottom-4 h-12 w-24 rounded-full shadow-lg" />}
        {!isStatus && compose && (
          <div className="absolute inset-0 z-20 bg-background">
            <ReadingPaneSkeleton mode="compose" />
          </div>
        )}
      </div>
    );
  }
  const reading = !!selected && folder !== "status";
  return (
    <div className="relative h-full">
      <div className="h-full" inert={reading || !!compose}>
        {folder === "status" ? <StatusFeed /> : <ThreadList />}
      </div>
      {!compose && !reading && folder !== "status" && (
        <Button size="lg" className="absolute right-4 bottom-4 h-12 rounded-full px-5 shadow-lg" onClick={() => startCompose("new")}>
          <PenSquare /> {savedDraft ? "Resume draft" : "New"}
        </Button>
      )}
      {reading && (
        <div className="absolute inset-0 z-10 bg-background" inert={!!compose}>
          <ReadingPane />
        </div>
      )}
      {compose && (
        <div className="absolute inset-0 z-20 bg-background">
          <Composer />
        </div>
      )}
      <FolderDrawer />
    </div>
  );
}

function FolderDrawer() {
  const { navOpen, setNavOpen } = useMailroom();
  // Phone Back closes the drawer. Swipe/overlay dismiss marks the history entry a no-op
  // (auto-skipped) so setFolder can close the drawer without racing history.back.
  useBackLayer(navOpen, () => setNavOpen(false));
  return (
    <Sheet open={navOpen} onOpenChange={setNavOpen}>
      <SheetContent side="left" className="w-[85vw] max-w-xs gap-0 p-0" showCloseButton={false}>
        <SheetTitle className="sr-only">Folders</SheetTitle>
        <FolderPane />
      </SheetContent>
    </Sheet>
  );
}

/** Tablets: conversation list and reading pane side by side; folders in the drawer. */
function TabletMailView({ loading = false }: { loading?: boolean }) {
  const { folder, compose } = useMailroom();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "mailroom-panes-tablet",
    panelIds: ["list", "reading"],
    storage: paneStorage,
  });
  useLayoutEffect(() => {
    applyPaneLayout("mailroom-panes-tablet", defaultLayout as Record<string, number> | undefined);
  }, [defaultLayout, folder, loading]);
  const isStatus = folder === "status";
  const skelAttrs = loading
    ? {
        "data-skeleton": isStatus ? "mail-status" : "mail",
        "data-skeleton-variant": resolveMailSkeletonVariant(folder),
        role: "status" as const,
        "aria-busy": true as const,
        "aria-label": "Loading mail",
      }
    : {};
  return (
    <div {...skelAttrs} className="h-full">
      {isStatus ? (
        loading ? <StatusFeedSkeleton /> : <StatusFeed />
      ) : (
        <ResizablePanelGroup orientation="horizontal" id="mailroom-panes-tablet" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
          <ResizablePanel id="list" defaultSize="42%" minSize="280px">
            {loading ? <ThreadListSkeleton folder={folder} /> : <ThreadList />}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="reading" defaultSize="58%" minSize="340px">
            {loading ? <ReadingPaneSkeleton mode={compose ? "compose" : "empty"} /> : <ReadingPane />}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
      {!loading && <FolderDrawer />}
    </div>
  );
}

function DesktopMailView({ loading = false }: { loading?: boolean }) {
  const { folder, compose } = useMailroom();
  const panelIds = folder === "status" ? ["folders", "status"] : ["folders", "list", "reading"];
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "mailroom-panes",
    panelIds,
    storage: paneStorage,
  });
  useLayoutEffect(() => {
    applyPaneLayout("mailroom-panes", defaultLayout as Record<string, number> | undefined);
  }, [defaultLayout, folder, loading]);
  const isStatus = folder === "status";
  const skelAttrs = loading
    ? {
        "data-skeleton": isStatus ? "mail-status" : "mail",
        "data-skeleton-variant": resolveMailSkeletonVariant(folder),
        role: "status" as const,
        "aria-busy": true as const,
        "aria-label": "Loading mail",
      }
    : {};
  return (
    <div {...skelAttrs} className="h-full">
      <ResizablePanelGroup orientation="horizontal" id="mailroom-panes" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id="folders" defaultSize="17%" minSize="180px" maxSize="28%">
          {loading ? <FolderSidebarSkeleton /> : <FolderPane />}
        </ResizablePanel>
        <ResizableHandle />
        {isStatus ? (
          <ResizablePanel id="status" defaultSize="83%">
            {loading ? <StatusFeedSkeleton /> : <StatusFeed />}
          </ResizablePanel>
        ) : (
          <>
            <ResizablePanel id="list" defaultSize="30%" minSize="280px">
              {loading ? <ThreadListSkeleton folder={folder} /> : <ThreadList />}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="reading" defaultSize="53%" minSize="360px">
              {loading ? <ReadingPaneSkeleton mode={compose ? "compose" : "empty"} /> : <ReadingPane />}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

function MailView({ loading = false }: { loading?: boolean }) {
  const mobile = useIsMobile();
  const tablet = useIsTablet();
  if (mobile) return <MobileMailView loading={loading} />;
  if (tablet) return <TabletMailView loading={loading} />;
  return <DesktopMailView loading={loading} />;
}

function Shell() {
  const { view, startCompose, snap, error } = useMailroom();
  const [booted, setBooted] = useState(false);
  useIsomorphicLayoutEffect(() => { setBooted(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "n") {
        e.preventDefault();
        startCompose("new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startCompose]);
  useKeyboardViewport();

  const waiting = !snap && !error;

  return (
    <div className="mailroom-shell relative flex h-full max-h-dvh flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <Rail />
        <main className="min-h-0 min-w-0 flex-1">
          {!booted ? (
            <div className="h-full" role="status" aria-busy="true" aria-label="Loading mailroom" />
          ) : waiting ? (
            view === "mail" ? <MailView loading /> : <PageSkeleton view={view} />
          ) : (
            <>
              {view === "mail" && <MailView />}
              {view === "goals" && <GoalsView />}
              {view === "team" && <TeamView />}
              {view === "machine" && <MachineView />}
              {view === "files" && <FilesView />}
            </>
          )}
        </main>
      </div>
      <SummonDialog />
      <ResolveHumanDialog />
      <FileViewer />
    </div>
  );
}

export function AppShell() {
  return (
    <MailroomProvider>
      <Shell />
    </MailroomProvider>
  );
}
