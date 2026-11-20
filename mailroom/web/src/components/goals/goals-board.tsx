"use client";

import { Check, ChevronDown, CircleCheck, Flag, TriangleAlert } from "lucide-react";
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
  sortTasksByPriority,
  type ParsedTaskStage,
  type TaskStage,
} from "@/lib/format";
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
      <Badge
        variant="outline"
        data-stage={stage}
        title={`${meta.label} — ${meta.description}`}
        className={TASK_STAGE_STYLE[stage].cls}
      >
        {meta.shortLabel}
      </Badge>
    );
  }
  if (!parsed) return null;
  if (parsed.kind === "malformed") {
    const raw = parsed.rawPrefix ?? "";
    return (
      <Badge
        variant="outline"
        data-stage="malformed"
        title={`Malformed stage prefix: [${raw}]`}
        className="border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300"
      >
        {raw ? `Malformed: [${raw}]` : "Malformed: []"}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      data-stage="unprefixed"
      title="Missing D38 [Stage] prefix in next_action"
      className="border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300"
    >
      No stage
    </Badge>
  );
}

const PRIORITY_LEVELS: readonly TaskPriority[] = ["high", "normal", "low"];

export function PriorityFlag({ priority }: { priority?: TaskPriority | string | null }) {
  const raw = (priority ?? "normal").toLowerCase();
  const key: TaskPriority = raw === "high" || raw === "low" ? raw : "normal";
  const style = PRIORITY_STYLE[key];
  return (
    <Badge
      variant="outline"
      data-task-priority={key}
      title={`Priority: ${style.label}`}
      className={cn("gap-1 text-[11px]", style.cls)}
    >
      <Flag className={cn("size-3 fill-current", style.dotCls)} aria-hidden="true" />
      {style.label}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority?: TaskPriority | string | null }) {
  return <PriorityFlag priority={priority} />;
}

export function PriorityFlagControl({
  task,
  admin,
  disabled = false,
  onChangePriority,
}: {
  task: Pick<GoalTask, "id" | "priority">;
  admin: boolean;
  disabled?: boolean;
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
            title="Change priority (USER only)"
            className={cn("h-5 gap-1 rounded-md px-1.5 text-[11px] font-medium", style.cls)}
          >
            <Flag className={cn("size-3 fill-current", style.dotCls)} aria-hidden="true" />
            {style.label}
            <ChevronDown className="size-2.5 opacity-75" aria-hidden="true" />
          </Button>
        }
      />
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
}

function BoardCard({ task, parsed, selectedId, admin, busy = false, onSelect, onChangePriority }: BoardCardProps) {
  const isSelected = selectedId === task.id;
  const heading = titleParts(task.title).heading;
  const summaryText =
    task.state === "blocked" && task.blocker.trim()
      ? `Blocker: ${task.blocker.trim()}`
      : parsed.text;
  const isBlockerSummary = task.state === "blocked" && !!task.blocker.trim();

  return (
    <Card
      size="sm"
      data-task-card={task.id}
      className={cn(
        "shrink-0 gap-0 border border-border/80 py-0 ring-0 shadow-xs transition-colors",
        task.state === "done" && !isSelected && "border-border/50 bg-muted/35",
        task.state === "blocked" && "border-l-2 border-l-amber-500",
        isSelected && "border-primary/70 bg-primary/8",
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          aria-current={isSelected ? "true" : undefined}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant="ghost" className="px-0 font-mono text-xs text-muted-foreground">
            {task.id}
          </Badge>
          <StateBadge task={task} />
          <DecisionBadge decision={task.decision} />
          {!parsed.stage && <StageBadge stage={null} parsed={parsed} />}
          <Badge variant="outline" className="text-[11px]">
            {task.owner === "user" ? "USER" : task.owner || "Unassigned"}
          </Badge>
        </button>
        <PriorityFlagControl
          task={task}
          admin={admin}
          disabled={busy}
          onChangePriority={onChangePriority}
        />
      </div>
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        aria-current={isSelected ? "true" : undefined}
        className="block w-full min-w-0 rounded-b-xl px-3 pt-0.5 pb-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p
          className={cn(
            "line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere]",
            task.state === "done" && !isSelected ? "font-normal text-muted-foreground" : "font-medium",
          )}
        >
          {heading}
        </p>
        {summaryText && (
          <p
            className={cn(
              "mt-1 line-clamp-2 text-xs leading-snug [overflow-wrap:anywhere]",
              isBlockerSummary ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
            )}
          >
            {summaryText}
          </p>
        )}
      </button>
    </Card>
  );
}

interface GoalsBoardProps {
  tasks: readonly GoalTask[];
  selectedId: string;
  admin: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onChangePriority?: (taskId: string, priority: TaskPriority) => void;
}

export function GoalsBoard({ tasks, selectedId, admin, busy = false, onSelect, onChangePriority }: GoalsBoardProps) {
  const { columns, unstaged } = groupTasksByStage(sortTasksByPriority(tasks));

  return (
    <div
      role="region"
      aria-label="Pipeline stages board"
      className="flex min-w-0 items-start gap-3 overflow-x-auto p-1 pb-3"
    >
      {unstaged.length > 0 && (
        <section
          data-stage-column="unstaged"
          aria-label="Needs stage"
          className="flex w-[17.5rem] shrink-0 flex-col gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3"
        >
          <header className="flex items-center justify-between gap-2 px-0.5">
            <div className="flex items-center gap-1.5">
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
          <p className="px-0.5 text-[11px] text-amber-800 dark:text-amber-300">
            Unprefixed or malformed D38 [Stage] tag
          </p>
          <div data-stage-scroll="unstaged" className="grid max-h-[min(70dvh,46rem)] auto-rows-max gap-2.5 overflow-y-auto p-1.5">
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
            className="flex w-[17.5rem] shrink-0 flex-col gap-2.5 rounded-xl border bg-muted/25 p-3"
          >
            <header className="space-y-1 px-0.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{idx + 1}.</span>
                  <StageBadge stage={col.stage} />
                </div>
                <div className="flex items-center gap-1">
                  {blockedCount > 0 && (
                    <Badge variant="secondary" className={cn("tabular-nums", GOAL_STATE_STYLE.blocked.cls)}>
                      {blockedCount} blocked
                    </Badge>
                  )}
                  <Badge variant="secondary" className="tabular-nums">
                    {col.items.length}
                  </Badge>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{meta.description}</p>
            </header>
            {col.items.length > 0 ? (
              <div data-stage-scroll={col.stage} className="grid max-h-[min(70dvh,46rem)] auto-rows-max gap-2.5 overflow-y-auto p-1.5">
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
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-2.5 py-4 text-center text-xs text-muted-foreground">
                No tasks in {meta.shortLabel}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
