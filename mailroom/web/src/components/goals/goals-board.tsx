"use client";

import { Fragment } from "react";
import { ChevronDown, CircleCheck, FileText, FolderOpen, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OpenFolderAction } from "@/components/viewer/repo-folder-dialog";
import { fileHref } from "@/lib/api";
import {
  GOAL_STATE_STYLE,
  PRIORITY_STYLE,
  TASK_STAGE_STYLE,
  extractTaskDocLinks,
  groupTasksByStage,
  plainTaskTitle,
  sortTasksByPriority,
  type ParsedTaskStage,
  type TaskDocFolder,
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

export function PriorityBadge({ priority }: { priority?: TaskPriority | string | null }) {
  const raw = (priority ?? "normal").toLowerCase();
  const key = raw === "high" || raw === "low" ? raw : "normal";
  const style = PRIORITY_STYLE[key];
  return (
    <Badge variant="outline" data-task-priority={key} className={cn("text-[11px]", style.cls)}>
      {style.label}
    </Badge>
  );
}

interface ViewableDocEntry {
  path: string;
  href: string;
  label: string;
}

export function TaskDocFooter({
  task,
  admin,
  onOpenFile,
  onOpenFolder,
  showFolderLine = true,
  className,
}: {
  task: Pick<GoalTask, "id" | "links">;
  admin: boolean;
  onOpenFile: (file: { href: string; path: string }) => void;
  onOpenFolder: (folder: TaskDocFolder) => void;
  showFolderLine?: boolean;
  className?: string;
}) {
  const docLinks = extractTaskDocLinks(task.links, task.id);

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

  const shownPaths = new Set<string>(
    [docLinks.context, docLinks.dossier, docLinks.pdf].filter((p): p is string => !!p && !!fileHref(p)),
  );

  // When a task has no repo folder of its own, surface up to 2 related links directly for 1-click access.
  const fallbackPaths = !quickButtons.length && docLinks.ownedFolders.length === 0
    ? docLinks.relatedLinks.filter((p) => !!fileHref(p)).slice(0, 2)
    : [];
  const fallbackRelated = fallbackPaths
    .map((p) => renderDocButton(p.split("/").at(-1) || p, p))
    .filter(Boolean);
  for (const p of fallbackPaths) {
    shownPaths.add(p);
  }

  const makeEntry = (path: string | null, role?: string): ViewableDocEntry | null => {
    if (!path || shownPaths.has(path)) return null;
    const href = fileHref(path);
    if (!href) return null;
    const base = path.split("/").at(-1) || path;
    return { path, href, label: role ? `${role} · ${base}` : base };
  };

  const secondaryOwnedGroups: { folder: string; label: string; entries: ViewableDocEntry[] }[] = [];
  const groupedPaths = new Set<string>();
  for (const folderDoc of docLinks.ownedFolders.slice(1)) {
    const entries = [
      makeEntry(folderDoc.context, "Context"),
      makeEntry(folderDoc.dossier, "Dossier"),
      makeEntry(folderDoc.pdf, "PDF"),
      ...folderDoc.extra.map((p) => makeEntry(p)),
    ].filter((e): e is ViewableDocEntry => e !== null);
    if (entries.length > 0) {
      for (const e of entries) groupedPaths.add(e.path);
      secondaryOwnedGroups.push({ folder: folderDoc.folder, label: folderDoc.label, entries });
    }
  }

  const primaryExtraEntries = (docLinks.ownedFolders[0]?.extra ?? [])
    .map((p) => makeEntry(p))
    .filter((e): e is ViewableDocEntry => e !== null);

  const relatedEntries = docLinks.relatedLinks
    .filter((p) => !shownPaths.has(p) && !groupedPaths.has(p))
    .map((p) => makeEntry(p))
    .filter((e): e is ViewableDocEntry => e !== null);

  const ownedExtraCount = secondaryOwnedGroups.reduce((sum, g) => sum + g.entries.length, 0) + primaryExtraEntries.length;
  const extraDocsCount = ownedExtraCount + relatedEntries.length;
  const canOpenFolder = admin && docLinks.ownedFolders.length > 0;
  const hasFooter =
    (showFolderLine && !!docLinks.folderLabel)
    || quickButtons.length > 0
    || canOpenFolder
    || fallbackRelated.length > 0
    || extraDocsCount > 0;

  if (!hasFooter) return null;

  const menuTriggerLabel = ownedExtraCount === 0 && relatedEntries.length > 0
    ? `+${relatedEntries.length} related`
    : `+${extraDocsCount} more`;

  return (
    <div className={cn("flex flex-col gap-1.5 border-t border-border/60 px-2.5 py-1.5", className)}>
      {showFolderLine && docLinks.folderLabel && (
        <span
          title={docLinks.folder ?? docLinks.folderLabel}
          className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[11px] text-muted-foreground"
        >
          <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{docLinks.folderLabel}</span>
        </span>
      )}
      {(quickButtons.length > 0 || canOpenFolder || fallbackRelated.length > 0 || extraDocsCount > 0) && (
        <div className="flex flex-wrap items-center gap-1">
          {quickButtons}
          <OpenFolderAction
            admin={admin}
            folders={docLinks.ownedFolders}
            onOpenFolder={onOpenFolder}
            size="xs"
          />
          {fallbackRelated}
          {extraDocsCount > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    aria-label={`More linked documents for ${task.id}`}
                    className="h-6 gap-0.5 px-1.5 text-[11px] tabular-nums"
                  >
                    {menuTriggerLabel}
                    <ChevronDown className="size-3" aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
                {primaryExtraEntries.length > 0 && (
                  <DropdownMenuGroup>
                    <DropdownMenuLabel className="truncate font-mono text-[11px]" title={docLinks.folder ?? undefined}>
                      {docLinks.folderLabel ?? "Folder files"}
                    </DropdownMenuLabel>
                    {primaryExtraEntries.map((entry) => (
                      <DropdownMenuItem
                        key={entry.path}
                        title={entry.path}
                        onClick={() => onOpenFile({ href: entry.href, path: entry.path })}
                      >
                        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{entry.label}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                )}
                {secondaryOwnedGroups.map((group, idx) => (
                  <Fragment key={group.folder}>
                    {(idx > 0 || primaryExtraEntries.length > 0) && <DropdownMenuSeparator />}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="truncate font-mono text-[11px]" title={group.folder}>
                        {group.label}
                      </DropdownMenuLabel>
                      {group.entries.map((entry) => (
                        <DropdownMenuItem
                          key={entry.path}
                          title={entry.path}
                          onClick={() => onOpenFile({ href: entry.href, path: entry.path })}
                        >
                          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{entry.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </Fragment>
                ))}
                {relatedEntries.length > 0 && (
                  <>
                    {(secondaryOwnedGroups.length > 0 || primaryExtraEntries.length > 0) && <DropdownMenuSeparator />}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-[11px]">Related evidence</DropdownMenuLabel>
                      {relatedEntries.map((entry) => (
                        <DropdownMenuItem
                          key={entry.path}
                          title={entry.path}
                          onClick={() => onOpenFile({ href: entry.href, path: entry.path })}
                        >
                          <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">{entry.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}

interface BoardCardProps {
  task: GoalTask;
  parsed: ParsedTaskStage;
  selectedId: string;
  admin: boolean;
  onSelect: (id: string) => void;
  onOpenFile: (file: { href: string; path: string }) => void;
  onOpenFolder: (folder: TaskDocFolder) => void;
}

function BoardCard({ task, parsed, selectedId, admin, onSelect, onOpenFile, onOpenFolder }: BoardCardProps) {
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
        "shrink-0 gap-0 py-0 shadow-xs transition-colors",
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
          <DecisionBadge decision={task.decision} />
          {!parsed.stage && <StageBadge stage={null} parsed={parsed} />}
          <PriorityBadge priority={task.priority} />
          <Badge variant="outline" className="text-[11px]">
            {task.owner === "user" ? "USER" : task.owner || "Unassigned"}
          </Badge>
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
      <TaskDocFooter
        task={task}
        admin={admin}
        onOpenFile={onOpenFile}
        onOpenFolder={onOpenFolder}
      />
    </Card>
  );
}

interface GoalsBoardProps {
  tasks: readonly GoalTask[];
  selectedId: string;
  admin: boolean;
  onSelect: (id: string) => void;
  onOpenFile: (file: { href: string; path: string }) => void;
  onOpenFolder: (folder: TaskDocFolder) => void;
}

export function GoalsBoard({ tasks, selectedId, admin, onSelect, onOpenFile, onOpenFolder }: GoalsBoardProps) {
  const { columns, unstaged } = groupTasksByStage(sortTasksByPriority(tasks));

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
          <div data-stage-scroll="unstaged" className="grid max-h-[min(70dvh,46rem)] auto-rows-max gap-2 overflow-y-auto pr-0.5">
            {unstaged.map(({ task, parsed }) => (
              <BoardCard
                key={task.id}
                task={task}
                parsed={parsed}
                selectedId={selectedId}
                admin={admin}
                onSelect={onSelect}
                onOpenFile={onOpenFile}
                onOpenFolder={onOpenFolder}
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
              <div data-stage-scroll={col.stage} className="grid max-h-[min(70dvh,46rem)] auto-rows-max gap-2 overflow-y-auto pr-0.5">
                {col.items.map(({ task, parsed }) => (
                  <BoardCard
                    key={task.id}
                    task={task}
                    parsed={parsed}
                    selectedId={selectedId}
                    admin={admin}
                    onSelect={onSelect}
                    onOpenFile={onOpenFile}
                    onOpenFolder={onOpenFolder}
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
