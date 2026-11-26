"use client";

import type { FolderId } from "@/lib/threads";
import {
  resolveGoalsSkeletonMode,
  resolveMailSkeletonVariant,
  type GoalsSkeletonMode,
  type MailSkeletonVariant,
} from "@/lib/skeleton";
import { cn } from "@/lib/utils";
import type { View } from "./context";

export {
  resolveGoalsSkeletonMode,
  resolveMailSkeletonVariant,
  type GoalsSkeletonMode,
  type MailSkeletonVariant,
};

export const MAIL_THREAD_LIST_HEADER_CLS = "flex items-center gap-1.5 border-b px-2.5 py-2 sm:gap-2 sm:px-3 sm:py-2.5";
export const MAIL_READING_TOOLBAR_CLS = "flex min-w-0 flex-wrap items-center gap-0.5 border-b px-1.5 py-1 sm:px-3 sm:py-1.5";
export const STATUS_HEADER_CLS = "border-b px-3 py-2 sm:px-4 sm:py-2.5";

export const GOALS_HEADER_CLS = "flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-card/40 px-3 py-1.5 sm:min-h-12 sm:px-5";
export const GOALS_TOP_BAR_CLS = "mb-2 flex flex-wrap items-center gap-1 rounded-lg border border-border/80 bg-card/60 px-1.5 py-1 sm:mb-2.5 sm:px-2 sm:py-1.5";
export const GOALS_TAB_ROW_CLS = "contents sm:flex sm:flex-wrap sm:items-center sm:gap-0.5 min-[1360px]:gap-1";
export const GOALS_FILTER_GRID_CLS = "mb-2 grid grid-cols-2 gap-1.5 sm:mb-3 sm:grid-cols-3 sm:gap-2 lg:grid-cols-5";
export const GOALS_BOARD_GRID_CLS = "grid min-h-0 flex-1 min-w-0 grid-flow-col auto-cols-[14rem] grid-rows-[minmax(0,1fr)] items-stretch gap-2 overflow-x-auto overflow-y-hidden p-0.5";
export const GOALS_BOARD_DESKTOP_COLS_6 = "min-[1100px]:grid-flow-row min-[1100px]:grid-cols-6 min-[1100px]:auto-cols-auto min-[1100px]:overflow-x-visible";
export const GOALS_BOARD_DESKTOP_COLS_7 = "min-[1280px]:grid-flow-row min-[1280px]:grid-cols-7 min-[1280px]:auto-cols-auto min-[1280px]:overflow-x-visible";

export const TEAM_CONTAINER_CLS = "mx-auto max-w-6xl space-y-6 p-3 pb-6 sm:space-y-8 sm:p-5 sm:pb-8 lg:space-y-10 lg:p-6";
export const HEALTH_STRIP_GRID_CLS = "grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-5";
export const AGENT_CARDS_GRID_CLS = "grid gap-4 sm:grid-cols-2 xl:grid-cols-3";
export const ROUTES_GRID_CLS = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3";

export const MACHINE_CONTAINER_CLS = "mx-auto max-w-5xl space-y-6 p-3 pb-6 sm:space-y-8 sm:p-5 sm:pb-8 lg:p-6";
export const MACHINES_GRID_CLS = "grid gap-4 md:grid-cols-2";

export const FILES_HEADER_CLS = "flex items-center gap-2 border-b px-3 py-2 sm:px-4";
export const FILES_TOOLBAR_CLS = "flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 sm:px-4 sm:py-2";

export function Bone({ className }: { className?: string }) {
  return <div className={cn("motion-safe:animate-pulse rounded bg-muted", className)} />;
}

function readStoredGoalsMode(): GoalsSkeletonMode {
  if (typeof window === "undefined") return "goals";
  try {
    return resolveGoalsSkeletonMode(localStorage.getItem("mr-goals-view"));
  } catch {
    return "goals";
  }
}

export function FolderSidebarSkeleton() {
  return (
    <div data-skeleton-pane="folders" className="flex h-full flex-col overflow-hidden bg-sidebar">
      <div className="space-y-2 p-3">
        <Bone className="h-9 w-full rounded-md" />
        <Bone className="h-9 w-full rounded-md" />
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-hidden px-2">
        <div className="space-y-1">
          <Bone className="mx-1 my-1 h-3.5 w-16" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
              <Bone className="size-4 shrink-0" />
              <Bone className="h-3.5 flex-1" />
              <Bone className="h-3 w-5 shrink-0" />
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <Bone className="mx-1 my-1 h-3.5 w-28" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
              <Bone className="size-4 shrink-0" />
              <Bone className="h-3.5 flex-1" />
              <Bone className="h-3 w-6 shrink-0" />
            </div>
          ))}
        </div>
        <div className="space-y-1">
          <Bone className="mx-1 my-1 h-3.5 w-12" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 px-2 py-1.5">
              <Bone className="size-6 shrink-0 rounded-full" />
              <Bone className="h-3.5 flex-1" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadRowSkeleton({ showPill = false }: { showPill?: boolean }) {
  return (
    <div className="flex gap-3 border-b px-3 py-2.5">
      <Bone className="size-8 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Bone className="h-3.5 w-28" />
          <Bone className="ml-auto h-3 w-12 shrink-0" />
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Bone className="h-3.5 flex-1" />
          {showPill && <Bone className="h-4 w-12 shrink-0 rounded-full" />}
        </div>
        <div className="mt-1.5 space-y-1">
          <Bone className="h-2.5 w-11/12" />
          <Bone className="h-2.5 w-3/5" />
        </div>
      </div>
    </div>
  );
}

export function StatusFeedSkeleton() {
  return (
    <div data-skeleton-pane="status" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className={STATUS_HEADER_CLS}>
        <div className="flex items-center gap-2">
          <Bone className="size-7 shrink-0 rounded-md lg:hidden touch:size-9" />
          <Bone className="h-5 w-28" />
        </div>
        <Bone className="mt-1.5 h-3 w-72 max-w-full" />
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {["w-16", "w-10", "w-10", "w-10", "w-10"].map((w, i) => (
            <Bone key={i} className={cn("h-6 rounded-full", w)} />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto max-w-4xl space-y-4 p-3 sm:p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex gap-3 pl-1">
              <Bone className="size-6 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2 rounded-lg border bg-card px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Bone className="h-3 w-20" />
                  <Bone className="h-3 w-10" />
                  <Bone className="h-3 w-14" />
                  <Bone className="ml-auto h-3 w-16" />
                </div>
                <Bone className="h-3.5 w-11/12" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ThreadListSkeleton({ folder = "all" }: { folder?: FolderId | string }) {
  const variant = resolveMailSkeletonVariant(folder);
  return (
    <div data-skeleton-pane="list" className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className={MAIL_THREAD_LIST_HEADER_CLS}>
        <Bone className="size-7 shrink-0 rounded-md lg:hidden touch:size-8" />
        <Bone className="h-5 w-36 flex-1 max-w-44" />
        <Bone className="ml-auto h-7 w-24 shrink-0 rounded-lg touch:h-8" />
      </div>
      {variant === "tasks" && (
        <div className="flex flex-wrap gap-1 border-b px-3 py-2">
          {["w-10", "w-14", "w-16", "w-14"].map((w, i) => (
            <Bone key={i} className={cn("h-5 rounded-full", w)} />
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: 8 }, (_, i) => (
          <ThreadRowSkeleton key={i} showPill={variant === "tasks" || i % 2 === 0} />
        ))}
      </div>
    </div>
  );
}

export type ReadingSkeletonMode = "empty" | "compose";

export function ReadingPaneSkeleton({ mode = "empty" }: { mode?: ReadingSkeletonMode }) {
  if (mode === "compose") {
    return (
      <div data-skeleton-pane="reading" data-skeleton-reading="compose" className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-3 py-1.5 sm:py-2">
          <Bone className="size-4 shrink-0" />
          <Bone className="h-4 w-28" />
          <Bone className="ml-auto size-7 rounded-md touch:size-9" />
        </div>
        <div className="space-y-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <Bone className="h-4 w-8" />
            <Bone className="h-6 w-28 rounded-full" />
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-4 w-8" />
            <Bone className="h-6 w-24 rounded-full" />
          </div>
          <Bone className="h-8 w-full rounded-md" />
        </div>
        <div className="min-h-0 flex-1 space-y-2 p-3">
          <Bone className="h-3.5 w-3/4" />
          <Bone className="h-3.5 w-2/3" />
        </div>
        <div className="flex items-center justify-between border-t px-3 py-1.5 sm:py-2">
          <Bone className="h-8 w-24 rounded-md" />
          <Bone className="h-8 w-20 rounded-md" />
        </div>
      </div>
    );
  }
  return (
    <div
      data-skeleton-pane="reading"
      data-skeleton-reading="empty"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-hidden p-8 text-center"
    >
      <Bone className="size-16 shrink-0 rounded-2xl" />
      <div className="flex max-w-full flex-col items-center space-y-2">
        <Bone className="h-6 w-60 max-w-full rounded-md" />
        <Bone className="h-4 w-48 max-w-full" />
      </div>
    </div>
  );
}

function TaskRowCardSkeleton() {
  return (
    <div className="rounded-xl border border-border/80 bg-card">
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Bone className="h-4 w-10" />
          <Bone className="h-5 w-14 rounded-full" />
          <Bone className="h-5 w-14 rounded-full" />
          <Bone className="h-5 w-12 rounded-full" />
        </div>
        <Bone className="h-6 w-16 shrink-0 rounded-md" />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 pt-1 pb-2.5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Bone className="h-4 w-3/4" />
          <Bone className="h-3 w-1/2" />
        </div>
        <Bone className="size-4 shrink-0" />
      </div>
    </div>
  );
}

function BoardCardSkeleton({ withFooter = false }: { withFooter?: boolean }) {
  return (
    <div className="shrink-0 rounded-xl border border-border/80 bg-card">
      <div className="flex items-start justify-between gap-1.5 px-2.5 pt-2 pb-1">
        <div className="flex flex-wrap items-center gap-1">
          <Bone className="h-3.5 w-8" />
          <Bone className="h-4 w-12 rounded-full" />
          <Bone className="h-4 w-10 rounded-full" />
        </div>
        <Bone className="h-5 w-12 shrink-0 rounded" />
      </div>
      <div className="space-y-1.5 px-2.5 pt-0.5 pb-2">
        <Bone className="h-3.5 w-11/12" />
        <Bone className="h-3 w-3/4" />
      </div>
      {withFooter && (
        <div className="border-t border-border/60 px-2.5 py-1.5">
          <Bone className="h-3.5 w-20" />
        </div>
      )}
    </div>
  );
}

export function GoalsSkeleton({
  includeHeader = false,
  viewMode = "goals",
}: {
  includeHeader?: boolean;
  viewMode?: GoalsSkeletonMode;
}) {
  const board = viewMode === "board";
  const flatList = viewMode === "decisions" || viewMode === "ready" || viewMode === "active";

  return (
    <div
      data-skeleton={board ? "goals-board" : flatList ? "goals-list" : "goals"}
      data-skeleton-mode={viewMode}
      role="status"
      aria-busy="true"
      aria-label="Loading goals"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {includeHeader && (
        <header data-skeleton-header="goals" className={GOALS_HEADER_CLS}>
          <Bone className="mr-auto h-6 w-16" />
          <Bone className="h-8 w-20 rounded-md touch:h-9 sm:h-9" />
          <Bone className="h-8 w-20 rounded-md touch:h-9 sm:h-9" />
        </header>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3 pt-2 pb-2 sm:px-5 sm:pt-3">
        <div className="mx-auto w-full max-w-7xl shrink-0">
          <div className={GOALS_TOP_BAR_CLS}>
            <div className={GOALS_TAB_ROW_CLS}>
              {["w-[86px]", "w-[106px]", "w-[88px]", "w-[90px]", "w-[92px]"].map((w, i) => (
                <Bone key={i} className={cn("h-7 rounded-md touch:h-8", w)} />
              ))}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Bone className="h-2 w-12 rounded-full sm:w-16 min-[1360px]:w-28" />
              <Bone className="h-3.5 w-16" />
            </div>
          </div>
          <div className={GOALS_FILTER_GRID_CLS}>
            {Array.from({ length: 5 }, (_, i) => (
              <Bone key={i} className="h-8 min-h-8 w-full rounded-md touch:h-9 touch:min-h-9" />
            ))}
          </div>
        </div>

        {board ? (
          <div className={cn(GOALS_BOARD_GRID_CLS, GOALS_BOARD_DESKTOP_COLS_6)}>
            {Array.from({ length: 6 }, (_, colIdx) => (
              <section
                key={colIdx}
                className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-xl border bg-muted/25 p-2"
              >
                <div className="shrink-0 space-y-1.5 px-0.5">
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5">
                      <Bone className="h-3.5 w-4" />
                      <Bone className="h-5 w-16 rounded-full" />
                    </div>
                    <Bone className="h-5 w-6 rounded-full" />
                  </div>
                  <Bone className="h-3 w-5/6" />
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-0.5">
                  {Array.from({ length: colIdx === 5 ? 2 : 3 }, (__, cardIdx) => (
                    <BoardCardSkeleton key={cardIdx} withFooter={cardIdx === 0} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : flatList ? (
          <div className="min-h-0 flex-1 overflow-hidden pr-0.5 pb-2">
            <div className="mx-auto w-full max-w-7xl space-y-3">
              <Bone className="h-4 w-72 max-w-full" />
              <div className="space-y-2.5 p-0.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <TaskRowCardSkeleton key={i} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden pr-0.5 pb-2">
            <div className="mx-auto w-full max-w-7xl space-y-2.5">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="rounded-xl border border-border/80 bg-card">
                  <div className="flex items-center gap-2 px-3 py-3 pr-2">
                    <Bone className="h-4 w-4 shrink-0" />
                    <Bone className="h-5 w-10 shrink-0 rounded-full" />
                    <Bone className="h-4 flex-1 max-w-md" />
                    <Bone className="ml-auto h-5 w-8 shrink-0 rounded-full" />
                    <Bone className="h-8 w-8 shrink-0 rounded-md sm:w-24" />
                    <Bone className="size-8 shrink-0 rounded-md" />
                  </div>
                  <div className="flex items-center gap-3 px-3 pb-2.5">
                    <Bone className="h-1.5 flex-1 rounded-full" />
                    <Bone className="h-3 w-16 shrink-0" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function TaskDiscussionSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading discussion">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2.5">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              <Bone className="h-4 w-12" />
              <Bone className="h-4 w-14 rounded-full" />
              <Bone className="h-4 w-12 rounded-full" />
            </div>
            <Bone className="h-4 w-4/5" />
          </div>
          <Bone className="size-9 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

export function TaskDocumentsSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-busy="true" aria-label="Loading documents">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1">
            <Bone className="size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Bone className="h-3.5 w-2/3" />
              <Bone className="h-3 w-5/6" />
            </div>
          </div>
          <Bone className="h-9 w-14 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function MachinesPanelSkeleton() {
  return (
    <div className={MACHINES_GRID_CLS}>
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="rounded-xl border bg-card p-4">
          <div className="flex items-start gap-3">
            <Bone className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <Bone className="h-4 w-28" />
                <Bone className="ml-auto h-5 w-18 rounded-full" />
              </div>
              <Bone className="h-3 w-48 max-w-full" />
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {Array.from({ length: i === 0 ? 2 : 5 }, (__, j) => (
              <div key={j} className="flex items-center gap-2">
                <Bone className="size-3.5 shrink-0 rounded-full" />
                <Bone className="h-3 w-5/6" />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <Bone className="h-5 w-16 rounded" />
              <Bone className="h-5 w-16 rounded" />
              <Bone className="h-5 w-16 rounded" />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {Array.from({ length: i === 0 ? 4 : 2 }, (__, k) => (
                <Bone key={k} className="size-6 rounded-full" />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function TeamSkeleton() {
  return (
    <div
      data-skeleton="team"
      role="status"
      aria-busy="true"
      aria-label="Loading team"
      className="h-full overflow-hidden"
    >
      <div className={TEAM_CONTAINER_CLS}>
        <div className={HEALTH_STRIP_GRID_CLS}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={cn(
                "rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3",
                i === 3 && "order-last col-span-2 sm:order-none sm:col-span-2 lg:col-span-1",
              )}
            >
              <Bone className="h-3 w-24" />
              <Bone className="mt-2 h-7 w-16" />
            </div>
          ))}
        </div>

        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-64 space-y-1.5">
              <Bone className="h-5 w-16" />
              <Bone className="h-3.5 w-72 max-w-full" />
            </div>
            <Bone className="size-8 rounded-md" />
          </div>
          <div className={AGENT_CARDS_GRID_CLS}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex min-w-0 flex-col rounded-xl border bg-card p-3 shadow-xs sm:p-4">
                <div className="flex items-start gap-3">
                  <Bone className="size-10 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Bone className="h-4 w-24" />
                    <Bone className="h-3 w-28" />
                  </div>
                  <Bone className="h-5 w-16 shrink-0 rounded-full" />
                </div>
                <Bone className="mt-3 h-7 w-full rounded-md" />
                <div className="mt-3 space-y-1.5 rounded-md bg-muted/50 px-2.5 py-2">
                  <Bone className="h-4 w-20 rounded-full" />
                  <Bone className="h-3 w-full" />
                  <Bone className="h-3 w-4/5" />
                </div>
                <Bone className="mt-3 h-3 w-5/6" />
                <div className="mt-2 space-y-1.5">
                  <Bone className="h-4 w-3/4" />
                  <Bone className="h-3 w-2/3" />
                </div>
                <div className="mt-auto flex flex-wrap gap-1 pt-3">
                  {Array.from({ length: 5 }, (__, j) => (
                    <Bone key={j} className="size-7 rounded-md" />
                  ))}
                  <Bone className="ml-auto size-7 rounded-md" />
                  <Bone className="size-7 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div className="space-y-1.5">
            <Bone className="h-5 w-24" />
            <Bone className="h-3.5 w-80 max-w-full" />
          </div>
          <MachinesPanelSkeleton />
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-64 space-y-1.5">
              <Bone className="h-5 w-36" />
              <Bone className="h-3.5 w-64 max-w-full" />
            </div>
            <Bone className="size-8 rounded-md" />
          </div>
          <div className="rounded-lg border border-dashed p-6">
            <Bone className="mx-auto h-3.5 w-44" />
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-64 space-y-1.5">
              <Bone className="h-5 w-36" />
              <Bone className="h-3.5 w-72 max-w-full" />
            </div>
            <Bone className="h-4 w-24" />
          </div>
          <div className={ROUTES_GRID_CLS}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="rounded-lg border bg-card px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <Bone className="h-4 w-28" />
                  <Bone className="h-5 w-9 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function MachineSkeleton() {
  return (
    <div
      data-skeleton="machine"
      role="status"
      aria-busy="true"
      aria-label="Loading machines"
      className="h-full overflow-hidden"
    >
      <div className={MACHINE_CONTAINER_CLS}>
        <MachinesPanelSkeleton />
        <section className="rounded-xl border bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Bone className="size-4 shrink-0" />
            <Bone className="h-5 w-36" />
            <Bone className="ml-auto h-4 w-36" />
          </div>
          <Bone className="mt-3 h-2 w-full rounded-full" />
          <Bone className="mt-2 h-3 w-72 max-w-full" />
        </section>
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Bone className="size-4 shrink-0" />
            <Bone className="h-5 w-40" />
          </div>
          <div className="rounded-lg border border-dashed p-4">
            <Bone className="h-3.5 w-52" />
          </div>
        </section>
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Bone className="size-4 shrink-0" />
            <Bone className="h-5 w-36" />
          </div>
          <div className="divide-y rounded-lg border">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="px-4 py-3">
                <Bone className="h-4 w-3/4" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function FilesRowsSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5 sm:px-4 sm:py-2">
          <Bone className="size-4 shrink-0" />
          <Bone className="h-4 min-w-0 flex-1 max-w-xl" />
          <Bone className="hidden h-3 w-18 shrink-0 md:block" />
          <Bone className="hidden h-3 w-14 shrink-0 sm:block" />
          <Bone className="hidden h-3 w-16 shrink-0 sm:block" />
        </div>
      ))}
    </div>
  );
}

export function FilesSkeleton({ includeChrome = false }: { includeChrome?: boolean }) {
  if (!includeChrome) {
    return (
      <div data-skeleton="files-rows" role="status" aria-busy="true" aria-label="Loading files">
        <FilesRowsSkeleton />
      </div>
    );
  }
  return (
    <div
      data-skeleton="files"
      role="status"
      aria-busy="true"
      aria-label="Loading files"
      className="flex h-full flex-col overflow-hidden"
    >
      <div className={FILES_HEADER_CLS}>
        <Bone className="h-5 w-28" />
        <Bone className="hidden h-4 w-48 sm:block" />
      </div>
      <div className={FILES_TOOLBAR_CLS}>
        <div className="flex flex-wrap items-center gap-1">
          {["w-10", "w-16", "w-12", "w-20"].map((w, i) => (
            <Bone key={i} className={cn("h-6 rounded-full", w)} />
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Bone className="h-8 w-22 rounded-md touch:h-9" />
          <Bone className="h-8 w-20 rounded-md touch:h-9" />
          <Bone className="h-8 w-22 rounded-md touch:h-9" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FilesRowsSkeleton />
      </div>
    </div>
  );
}

export function GoalsPageFallback() {
  return <GoalsSkeleton includeHeader viewMode={readStoredGoalsMode()} />;
}

export function PageSkeleton({ view }: { view: Exclude<View, "mail"> }) {
  if (view === "goals") return <GoalsSkeleton includeHeader viewMode={readStoredGoalsMode()} />;
  if (view === "team") return <TeamSkeleton />;
  if (view === "machine") return <MachineSkeleton />;
  return <FilesSkeleton includeChrome />;
}
