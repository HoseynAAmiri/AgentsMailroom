"use client";

import { CircleCheck, FileText, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fileHref } from "@/lib/api";
import {
  GOAL_STATE_STYLE,
  TASK_STAGE_STYLE,
  extractTaskDocLinks,
  groupTasksByStage,
  plainTaskTitle,
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

export function StateBadge({ task }: { task: Pick<GoalTask, "state" | "decision"> }) {
  return (
    <Badge variant="secondary" className={GOAL_STATE_STYLE[task.state].cls}>
      {task.state === "done" && <CircleCheck data-icon="inline-start" aria-hidden="true" />}
      {task.decision ? "USER decision" : GOAL_STATE_STYLE[task.state].label}
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
    return (
      <Badge
        variant="outline"
        data-stage={stage}
        title={`Stage: ${stage}`}
        className={TASK_STAGE_STYLE[stage].cls}
      >
        {TASK_STAGE_STYLE[stage].label}
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

interface BoardCardProps {
  task: GoalTask;
  parsed: ParsedTaskStage;
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenFile: (file: { href: string; path: string }) => void;
}

function BoardCard({ task, parsed, selectedId, onSelect, onOpenFile }: BoardCardProps) {
  const isSelected = selectedId === task.id;
  const heading = titleParts(task.title).heading;
  const summaryText =
    task.state === "blocked" && task.blocker.trim()
      ? `Blocker: ${task.blocker.trim()}`
      : parsed.text;
  const isBlockerSummary = task.state === "blocked" && !!task.blocker.trim();
  const docLinks = extractTaskDocLinks(task.links);

  function renderDocButton(label: string, filePath: string | null) {
    if (!filePath) return null;
    const href = fileHref(filePath);
    if (!href) return null;
    return (
      <Button
        key={`${label}:${filePath}`}
        type="button"
        size="xs"
        variant="outline"
        title={filePath}
        className="h-6 px-1.5 text-[11px]"
        onClick={() => onOpenFile({ href, path: filePath })}
      >
        <FileText className="size-3" aria-hidden="true" />
        {label}
      </Button>
    );
  }

  const quickButtons = [
    renderDocButton("Context", docLinks.context),
    renderDocButton("Dossier", docLinks.dossier),
    renderDocButton("PDF", docLinks.pdf),
  ].filter(Boolean);

  const fallbackOther =
    !quickButtons.length ? docLinks.other.slice(0, 2).map((p) => renderDocButton(p.split("/").at(-1) || p, p)).filter(Boolean) : [];
  const extraCount = docLinks.other.length - (!quickButtons.length ? Math.min(2, docLinks.other.length) : 0);
  const hasFooter = !!docLinks.folderLabel || quickButtons.length > 0 || fallbackOther.length > 0 || extraCount > 0;

  return (
    <Card
      size="sm"
      data-task-card={task.id}
      className={cn(
        "gap-0 py-0 shadow-xs transition-colors",
        task.state === "done" && !isSelected && "bg-muted/35 ring-foreground/5",
        task.state === "blocked" && "border-l-2 border-l-amber-500",
        isSelected && "bg-primary/8 ring-primary/50",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        aria-current={isSelected ? "true" : undefined}
        className="block w-full min-w-0 rounded-xl p-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="ghost" className="px-0 font-mono text-xs text-muted-foreground">
            {task.id}
          </Badge>
          <StateBadge task={task} />
          {!parsed.stage && <StageBadge stage={null} parsed={parsed} />}
          <Badge variant="outline" className="text-[11px]">
            {task.owner === "user" ? "USER" : task.owner || "Unassigned"}
          </Badge>
          {task.priority !== "normal" && (
            <Badge variant="outline" className="text-[11px]">
              {task.priority === "high" ? "High" : "Low"}
            </Badge>
          )}
        </div>
        <p
          className={cn(
            "mt-1.5 line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere]",
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
      {hasFooter && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 px-2.5 py-1.5">
          {docLinks.folderLabel && (
            <span
              title={docLinks.folder ?? docLinks.folderLabel}
              className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[11px] text-muted-foreground"
            >
              <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{docLinks.folderLabel}</span>
            </span>
          )}
          {(quickButtons.length > 0 || fallbackOther.length > 0 || extraCount > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {quickButtons}
              {fallbackOther}
              {extraCount > 0 && (
                <span
                  title={docLinks.other.join("\n")}
                  className="px-1 text-[11px] text-muted-foreground tabular-nums"
                >
                  +{extraCount}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

interface GoalsBoardProps {
  tasks: readonly GoalTask[];
  selectedId: string;
  onSelect: (id: string) => void;
  onOpenFile: (file: { href: string; path: string }) => void;
}

export function GoalsBoard({ tasks, selectedId, onSelect, onOpenFile }: GoalsBoardProps) {
  const { columns, unstaged } = groupTasksByStage(tasks);

  return (
    <div
      role="region"
      aria-label="Pipeline stages board"
      className="flex min-w-0 items-start gap-3 overflow-x-auto pb-2"
    >
      {unstaged.length > 0 && (
        <section
          data-stage-column="unstaged"
          aria-label="Needs stage"
          className="flex w-[17.25rem] shrink-0 flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-2.5"
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
          <div className="flex max-h-[min(70dvh,46rem)] flex-col gap-2 overflow-y-auto pr-0.5">
            {unstaged.map(({ task, parsed }) => (
              <BoardCard
                key={task.id}
                task={task}
                parsed={parsed}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        </section>
      )}

      {columns.map((col, idx) => {
        const blockedCount = col.items.filter(({ task }) => task.state === "blocked").length;
        return (
          <section
            key={col.stage}
            data-stage-column={col.stage}
            aria-label={`Stage ${idx + 1}: ${col.stage}`}
            className="flex w-[17.25rem] shrink-0 flex-col gap-2 rounded-xl border bg-muted/25 p-2.5"
          >
            <header className="flex items-center justify-between gap-2 px-0.5">
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
            </header>
            {col.items.length > 0 ? (
              <div className="flex max-h-[min(70dvh,46rem)] flex-col gap-2 overflow-y-auto pr-0.5">
                {col.items.map(({ task, parsed }) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    parsed={parsed}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    onOpenFile={onOpenFile}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-2.5 py-4 text-center text-xs text-muted-foreground">
                No tasks in {col.stage}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
