"use client";

import { Check, ChevronDown, CircleCheck, Flag, FolderOpen, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GOAL_STATE_STYLE,
  PRIORITY_STYLE,
  TASK_STAGE_META,
  TASK_STAGE_STYLE,
  groupTasksByStage,
  plainTaskTitle,
  resolveTaskFilesFolder,
  sortTasksByPriority,
  type ParsedTaskStage,
  type TaskDocFolder,
  type TaskStage,
} from "@/lib/format";
import { HoverTip } from "@/components/ui/tooltip";
import {
  GOALS_BOARD_DESKTOP_COLS_6,
  GOALS_BOARD_DESKTOP_COLS_7,
  GOALS_BOARD_GRID_CLS,
} from "@/components/mailroom/page-skeletons";
import { cn } from "@/lib/utils";

export type TaskState = "todo" | "doing" | "blocked" | "done";
export type TaskPriority = "high" | "normal" | "low";

export interface GoalSummary {
  id: string;
  title: string;
  revision: number;
}

export interface GoalTask extends GoalSummary {
  goal_id: string;
  state: TaskState;
  priority: TaskPriority;
  owner: string;
  next_action: string;
  blocker: string;
  notes: string;
  decision: number;
  links?: string[];
}

export function titleParts(title: string) {
  const plain = plainTaskTitle(title);
  const end = plain.search(/[.!?]\s+(?=[A-Z])/);
  return end < 0
    ? { heading: plain, rest: "" }
    : { heading: plain.slice(0, end + 1), rest: plain.slice(end + 1).trim() };
}

export function StateBadge({ task }: { task: Pick<GoalTask, "state"> }) {
  return (
    <Badge variant="secondary" data-task-state={task.state} className={GOAL_STATE_STYLE[task.state].cls}>
      {task.state === "done" && <CircleCheck data-icon="inline-start" aria-hidden="true" />}
      {GOAL_STATE_STYLE[task.state].label}
    </Badge>
  );
}

export function DecisionBadge({ decision }: { decision?: number | boolean }) {
  if (!decision) return null;
  return (
    <Badge
      variant="outline"
      data-user-decision="true"
      className="border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300"
    >
      <TriangleAlert data-icon="inline-start" aria-hidden="true" />
      USER decision
    </Badge>
  );
}

export function shouldHideStateBadge(state: TaskState, stage: TaskStage | null): boolean {
  return state === "done" && stage === "Done";
}

export function StageBadge({
  stage,
  parsed,
}: {
  stage: TaskStage | null;
  parsed?: ParsedTaskStage;
}) {
  if (stage) {
    const meta = TASK_STAGE_META[stage];
    return (
      <HoverTip label={`${meta.label} — ${meta.description}`}>
        <Badge
          variant="outline"
          data-stage={stage}
          className={TASK_STAGE_STYLE[stage].cls}
        >
          {stage === "Done" && <CircleCheck data-icon="inline-start" aria-hidden="true" />}
          {meta.shortLabel}
        </Badge>
      </HoverTip>
    );
  }
  if (!parsed) return null;
  if (parsed.kind === "malformed") {
    const raw = parsed.rawPrefix ?? "";
    return (
      <HoverTip label={`Malformed stage prefix: [${raw}]`}>
        <Badge
          variant="outline"
          data-stage="malformed"
          className="border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300"
        >
          {raw ? `Malformed: [${raw}]` : "Malformed: []"}
        </Badge>
      </HoverTip>
    );
  }
  return (
    <HoverTip label="Missing [Stage] prefix in the next action">
      <Badge
        variant="outline"
        data-stage="unprefixed"
        className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
      >
        No stage
      </Badge>
    </HoverTip>
  );
}

const PRIORITY_LEVELS: readonly TaskPriority[] = ["high", "normal", "low"];

export function PriorityFlag({ priority }: { priority?: TaskPriority | string | null }) {
  const raw = (priority ?? "normal").toLowerCase();
  const key: TaskPriority = raw === "high" || raw === "low" ? raw : "normal";
  const style = PRIORITY_STYLE[key];
  return (
    <HoverTip label={`Priority: ${style.label}`}>
      <Badge
        variant="outline"
        data-task-priority={key}
        className={cn("gap-1 text-[11px]", style.cls)}
      >
        <Flag className={cn("size-3 fill-current", style.dotCls)} aria-hidden="true" />
        {style.label}
      </Badge>
    </HoverTip>
  );
}

export function PriorityBadge({ priority }: { priority?: TaskPriority | string | null }) {
  return <PriorityFlag priority={priority} />;
}

export function PriorityFlagControl({
  task,
  admin,
  disabled = false,
  compact = false,
  onChangePriority,
}: {
  task: Pick<GoalTask, "id" | "priority">;
  admin: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChangePriority?: (taskId: string, priority: TaskPriority) => void;
}) {
  if (!admin || !onChangePriority) {
    return <PriorityFlag priority={task.priority} />;
  }
  const raw = (task.priority ?? "normal").toLowerCase();
  const current: TaskPriority = raw === "high" || raw === "low" ? raw : "normal";
  const style = PRIORITY_STYLE[current];

  return (
    <DropdownMenu>
      <HoverTip label="Change priority (USER only)">
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            data-priority-control={task.id}
            data-task-priority={current}
            aria-label={`Priority for ${task.id}: ${style.label}. Change priority`}
            className={cn(
              compact
                ? "h-5 cursor-pointer gap-0.5 rounded px-1.5 text-[10px] font-medium transition-[filter,box-shadow] hover:brightness-95 dark:hover:brightness-110 touch:h-7"
                : "h-6 cursor-pointer gap-1 rounded-md px-2 text-[11px] font-medium transition-[filter,box-shadow] hover:brightness-95 dark:hover:brightness-110 touch:h-8",
              style.cls,
            )}
          >
            <Flag className={cn("size-3 fill-current", style.dotCls)} aria-hidden="true" />
            {style.label}
            <ChevronDown className="size-2.5 opacity-75" aria-hidden="true" />
          </Button>
        }
      />
      </HoverTip>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px]">Priority (USER)</DropdownMenuLabel>
          {PRIORITY_LEVELS.map((level) => {
            const opt = PRIORITY_STYLE[level];
            return (
              <DropdownMenuItem
                key={level}
                data-priority-option={level}
                disabled={disabled}
                onClick={() => onChangePriority(task.id, level)}
              >
                <Flag className={cn("size-3.5 fill-current", opt.dotCls)} aria-hidden="true" />
                <span className="flex-1">{opt.label}</span>
                {current === level && <Check className="size-3.5 text-foreground" aria-hidden="true" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface BoardCardProps {
  task: GoalTask;
  parsed: ParsedTaskStage;
  selectedId: string;
  admin: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onChangePriority?: (taskId: string, priority: TaskPriority) => void;
  onOpenFiles?: (folder: TaskDocFolder) => void;
}

function BoardCard({ task, parsed, selectedId, admin, busy = false, onSelect, onChangePriority, onOpenFiles }: BoardCardProps) {
  const isSelected = selectedId === task.id;
  const heading = titleParts(task.title).heading;
  const summaryText =
    task.state === "blocked" && task.blocker.trim()
      ? `Blocker: ${task.blocker.trim()}`
      : parsed.text;
  const isBlockerSummary = task.state === "blocked" && !!task.blocker.trim();
  const filesFolder = admin && onOpenFiles ? resolveTaskFilesFolder(task) : null;

  return (
    <Card
      size="sm"
      data-task-card={task.id}
      className={cn(
        "min-w-0 shrink-0 gap-0 border border-border/80 py-0 ring-0 shadow-xs transition-colors",
        task.state === "done" && !isSelected && "border-border/50 bg-muted/35",
        task.state === "blocked" && "border-l-2 border-l-amber-500",
        isSelected && "border-primary/70 bg-primary/8",
      )}
    >
      <div className="flex items-start justify-between gap-1.5 px-2.5 pt-2 pb-1">
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          aria-current={isSelected ? "true" : undefined}
          className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant="ghost" className="px-0 font-mono text-[11px] text-muted-foreground">
            {task.id}
          </Badge>
          <StateBadge task={task} />
          <DecisionBadge decision={task.decision} />
          {!parsed.stage && <StageBadge stage={null} parsed={parsed} />}
          <Badge variant="outline" className="px-1.5 text-[10px]">
            {task.owner === "user" ? "USER" : task.owner || "Unassigned"}
          </Badge>
        </button>
        <PriorityFlagControl
          task={task}
          admin={admin}
          disabled={busy}
          compact
          onChangePriority={onChangePriority}
        />
      </div>
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        aria-current={isSelected ? "true" : undefined}
        className={cn(
          "block w-full min-w-0 cursor-pointer px-2.5 pt-0.5 pb-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !filesFolder && "rounded-b-xl",
        )}
      >
        <p
          className={cn(
            "line-clamp-2 text-[13px] leading-snug [overflow-wrap:anywhere]",
            task.state === "done" && !isSelected ? "font-normal text-muted-foreground" : "font-medium",
          )}
        >
          {heading}
        </p>
        {summaryText && (
          <p
            className={cn(
              "mt-1 line-clamp-2 text-[11px] leading-snug [overflow-wrap:anywhere]",
              isBlockerSummary ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}
          >
            {summaryText}
          </p>
        )}
      </button>
      {filesFolder && (
        <div className="flex items-center border-t border-border/60 px-2 py-1">
          <HoverTip label={`Open files in ${filesFolder.folder}`}>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-open-files={task.id}
              data-open-files-path={filesFolder.folder}
              className="h-6 cursor-pointer gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => onOpenFiles?.(filesFolder)}
            >
              <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
              Open files
            </Button>
          </HoverTip>
        </div>
      )}
    </Card>
  );
}

interface GoalsBoardProps {
  tasks: readonly GoalTask[];
  selectedId: string;
  admin: boolean;
  busy?: boolean;
  constrained?: boolean;
  onSelect: (id: string) => void;
  onChangePriority?: (taskId: string, priority: TaskPriority) => void;
  onOpenFiles?: (folder: TaskDocFolder) => void;
}

export function GoalsBoard({
  tasks,
  selectedId,
  admin,
  busy = false,
  constrained = false,
  onSelect,
  onChangePriority,
  onOpenFiles,
}: GoalsBoardProps) {
  const { columns, unstaged } = groupTasksByStage(sortTasksByPriority(tasks));

  return (
    <div
      role="region"
      aria-label="Pipeline stages board"
      className={cn(
        GOALS_BOARD_GRID_CLS,
        !constrained && (unstaged.length > 0 ? GOALS_BOARD_DESKTOP_COLS_7 : GOALS_BOARD_DESKTOP_COLS_6),
      )}
    >
      {unstaged.length > 0 && (
        <section
          data-stage-column="unstaged"
          aria-label="Needs stage"
          className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/5 p-2"
        >
          <header className="flex shrink-0 items-center justify-between gap-1.5 px-0.5">
            <div className="flex items-center gap-1">
              <Badge
                variant="outline"
                className="border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300"
              >
                Needs stage
              </Badge>
            </div>
            <Badge variant="secondary" className="tabular-nums">
              {unstaged.length}
            </Badge>
          </header>
          <p className="shrink-0 px-0.5 text-[11px] text-amber-800 dark:text-amber-300">
            Unprefixed or malformed D38 [Stage] tag
          </p>
          <div data-stage-scroll="unstaged" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5">
            {unstaged.map(({ task, parsed }) => (
              <BoardCard
                key={task.id}
                task={task}
                parsed={parsed}
                selectedId={selectedId}
                admin={admin}
                busy={busy}
                onSelect={onSelect}
                onChangePriority={onChangePriority}
                onOpenFiles={onOpenFiles}
              />
            ))}
          </div>
        </section>
      )}

      {columns.map((col, idx) => {
        const blockedCount = col.items.filter(({ task }) => task.state === "blocked").length;
        const meta = TASK_STAGE_META[col.stage];
        return (
          <section
            key={col.stage}
            data-stage-column={col.stage}
            aria-label={`Stage ${idx + 1}: ${meta.label}`}
            className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-xl border bg-muted/25 p-2"
          >
            <header className="shrink-0 space-y-1 px-0.5">
              <div className="flex items-center justify-between gap-1">
                <div className="flex min-w-0 items-center gap-1">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{idx + 1}.</span>
                  <StageBadge stage={col.stage} />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {blockedCount > 0 && (
                    <Badge variant="secondary" className={cn("px-1.5 text-[10px] tabular-nums", GOAL_STATE_STYLE.blocked.cls)}>
                      {blockedCount}
                    </Badge>
                  )}
                  <Badge variant="secondary" className="px-1.5 text-[11px] tabular-nums">
                    {col.items.length}
                  </Badge>
                </div>
              </div>
              <HoverTip label={meta.description}>
                <p className="truncate text-[11px] text-muted-foreground">{meta.description}</p>
              </HoverTip>
            </header>
            {col.items.length > 0 ? (
              <div data-stage-scroll={col.stage} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5">
                {col.items.map(({ task, parsed }) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    parsed={parsed}
                    selectedId={selectedId}
                    admin={admin}
                    busy={busy}
                    onSelect={onSelect}
                    onChangePriority={onChangePriority}
                    onOpenFiles={onOpenFiles}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-2 py-3 text-center text-xs text-muted-foreground">
                Empty
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
