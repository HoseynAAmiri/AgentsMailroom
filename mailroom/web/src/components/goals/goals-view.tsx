"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, ArrowUpToLine, ChevronRight, CircleCheck, Columns3, FileText, Flag, Link2, ListChecks, ListFilter, MessageSquare, MoreHorizontal, Plus, Tag, Target, TriangleAlert, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SearchableSelect, type SearchOption } from "@/components/ui/searchable-select";
import { useBackLayer } from "@/hooks/use-back-layer";
import { api, fileHref } from "@/lib/api";
import { GOAL_STATE_STYLE, PRIORITY_STYLE, TASK_STAGES, extractTaskDocLinks, isTaskInProgress, isTaskReadyNext, parseTaskStage, plainTaskTitle, sortTasksByPriority, summarizeTaskProgress, type TaskDocFolder, type TaskProgressSummary } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMailroom } from "@/components/mailroom/context";
import { DecisionBadge, GoalsBoard, PriorityFlagControl, StageBadge, StateBadge, shouldHideStateBadge, titleParts, type GoalSummary as Goal, type GoalTask as Task, type TaskPriority } from "@/components/goals/goals-board";
import { CopyFolderPathAction, OpenFolderAction, RepoFolderDialog } from "@/components/viewer/repo-folder-dialog";

interface Tracker { goals: Goal[]; tasks: Task[]; order_revision: number; revision: number }
interface Evidence {
  events: { id: string; from: string; subject?: string; task_id?: string; excerpt: string; type: string }[];
  files: string[];
  manual_files: string[];
  total: number;
  file_total: number;
}
type Edit = { kind: "goal" | "task"; id?: string; revision?: number; fields: Record<string, string | boolean> };
type GoalsViewMode = "goals" | "decisions" | "ready" | "active" | "board";
const textClass = "text-sm text-muted-foreground";
const pageSize = 30;
const stateOptions = Object.entries(GOAL_STATE_STYLE).map(([value, { label }]) => ({ value, label }));
const stageOptions = TASK_STAGES.map((value) => ({ value, label: value }));
const priorities = ["high", "normal", "low"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const PRIORITY_FILTERS = [
  { value: "", label: "All" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
] as const;
const ACTIVE_FILTER_OUTLINE = "border-primary bg-primary/15 font-medium text-foreground ring-1 ring-primary/40";

function TaskProgressBar({
  summary,
  label,
  compact = false,
  className,
  dataAttr,
}: {
  summary: TaskProgressSummary;
  label: string;
  compact?: boolean;
  className?: string;
  dataAttr?: Record<string, string>;
}) {
  const tooltip = `${summary.done} of ${summary.total} done (${summary.donePct}%)`;
  return (
    <div {...dataAttr} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.donePct}
        title={tooltip}
        className={cn(
          "relative flex flex-1 overflow-hidden rounded-full bg-muted",
          compact ? "h-1.5 min-w-24" : "h-2 min-w-36",
        )}
      >
        {summary.doneWidthPct > 0 && (
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${summary.doneWidthPct}%` }}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        <span className="font-medium text-emerald-700 dark:text-emerald-300">
          {summary.done} of {summary.total} done
        </span>
      </div>
    </div>
  );
}

interface TaskRowCardProps {
  task: Task;
  selected: boolean;
  showGoalBadge?: boolean;
  admin: boolean;
  busy?: boolean;
  onSelect: (id: string) => void;
  onChangePriority?: (taskId: string, priority: TaskPriority) => void;
}

function TaskRowCard({
  task,
  selected,
  showGoalBadge = false,
  admin,
  busy = false,
  onSelect,
  onChangePriority,
}: TaskRowCardProps) {
  const parsed = parseTaskStage(task.next_action);
  const summaryText =
    task.state === "blocked" && task.blocker.trim()
      ? `Blocker: ${task.blocker.trim()}`
      : parsed.text;
  const isBlockerSummary = task.state === "blocked" && !!task.blocker.trim();

  return (
    <Card
      size="sm"
      data-goal-row={task.id}
      className={cn(
        "gap-0 border border-border/80 py-0 ring-0 shadow-none transition-colors",
        task.state === "done" && !selected && "border-border/50 bg-muted/35",
        task.state === "blocked" && "border-l-2 border-l-amber-500",
        selected && "border-primary/70 bg-primary/8",
      )}
    >
      <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
        <button
          type="button"
          onClick={() => onSelect(task.id)}
          aria-current={selected ? "true" : undefined}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Badge variant="ghost" className="px-0 font-mono text-muted-foreground">{task.id}</Badge>
          {showGoalBadge && <Badge variant="outline" className="font-mono text-[11px]">{task.goal_id}</Badge>}
          {!shouldHideStateBadge(task.state, parsed.stage) && <StateBadge task={task} />}
          <DecisionBadge decision={task.decision} />
          <StageBadge stage={parsed.stage} parsed={parsed} />
          <Badge variant="outline" className="text-[11px]">{task.owner === "user" ? "USER" : task.owner || "Unassigned"}</Badge>
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
        aria-current={selected ? "true" : undefined}
        className="flex h-auto min-h-9 w-full min-w-0 items-center justify-between gap-3 rounded-b-xl px-3 pt-0.5 pb-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:pb-3"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span
            className={cn(
              "line-clamp-2 block text-sm leading-snug [overflow-wrap:anywhere]",
              task.state === "done" && !selected ? "font-normal text-muted-foreground" : "font-medium",
            )}
          >
            {titleParts(task.title).heading}
          </span>
          {summaryText && (
            <span
              className={cn(
                "line-clamp-2 block text-xs leading-snug [overflow-wrap:anywhere]",
                isBlockerSummary ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
              )}
            >
              {summaryText}
            </span>
          )}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </Card>
  );
}

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export function GoalsView() {
  const { snap, agents, search, openEvent, openFile, startCompose, registerViewRefresh, goalTaskId: selected, setGoalTaskId: setSelected } = useMailroom();
  const admin = !!snap?.capabilities?.admin;
  const [data, setData] = useState<Tracker>();
  const [error, setError] = useState("");
  const [goalFilter, setGoalFilter] = useState("");
  const [boardGoal, setBoardGoal] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [viewMode, setViewMode] = useState<GoalsViewMode>("goals");
  const [showFilters, setShowFilters] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<{ filter: string; ids: string[] }>();
  const [browseFolder, setBrowseFolder] = useState<TaskDocFolder | null>(null);
  const [evidence, setEvidence] = useState<Evidence>();
  const [detailError, setDetailError] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState("overview");
  const [edit, setEdit] = useState<Edit>();
  const [remove, setRemove] = useState<{ goal: Goal; count?: number }>();
  const [editError, setEditError] = useState("");
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [tagId, setTagId] = useState("");
  const [tagTarget, setTagTarget] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const lastId = snap?.last_id;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request<Tracker>("/api/todo");
      if (!signal?.aborted) {
        setData((previous) => !previous || result.revision > previous.revision ? result : previous);
        setError("");
      }
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { void load(controller.signal); });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal);
    }, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  useEffect(() => registerViewRefresh("goals", async () => {
    setDetailRefresh((n) => n + 1);
    await load();
  }), [load, registerViewRefresh]);

  useEffect(() => {
    if (!selected || !admin) return;
    let active = true;
    request<Evidence>(`/api/todo?id=${encodeURIComponent(selected)}&offset=${page * pageSize}`)
      .then((result) => { if (active) { setEvidence(result); setDetailError(""); } })
      .catch((cause: Error) => { if (active) setDetailError(cause.message); });
    return () => { active = false; };
  }, [admin, selected, page, data?.revision, lastId, detailRefresh]);

  useBackLayer(!!selected, () => setSelected(""));
  useBackLayer(!!edit, () => setEdit(undefined));
  useBackLayer(!!remove, () => setRemove(undefined));
  useBackLayer(!!browseFolder, () => setBrowseFolder(null));

  const activeGoal = viewMode === "board" ? boardGoal : goalFilter;
  const goal = data?.goals.find((row) => row.id === activeGoal);
  const task = data?.tasks.find((row) => row.id === selected);
  const sharedWithoutPriority = useMemo(() => data?.tasks.filter((row) => {
    const query = search.trim().toLowerCase();
    const { stage } = parseTaskStage(row.next_action);
    return (!stateFilter || row.state === stateFilter)
      && (!stageFilter || (stageFilter === "-" ? !stage : stage === stageFilter))
      && (!ownerFilter || row.owner === (ownerFilter === "-" ? "" : ownerFilter))
      && (!query || [row.id, row.title, row.notes, row.next_action, row.blocker].some((value) => value.toLowerCase().includes(query)));
  }) ?? [], [data, stateFilter, stageFilter, ownerFilter, search]);

  const listWithoutPriority = useMemo(
    () => sharedWithoutPriority.filter((row) => !goalFilter || row.goal_id === goalFilter),
    [sharedWithoutPriority, goalFilter],
  );
  const boardWithoutPriority = useMemo(
    () => sharedWithoutPriority.filter((row) => !boardGoal || row.goal_id === boardGoal),
    [sharedWithoutPriority, boardGoal],
  );

  const rows = useMemo(
    () => sortTasksByPriority(listWithoutPriority.filter((row) => !priorityFilter || row.priority === priorityFilter)),
    [listWithoutPriority, priorityFilter],
  );
  const boardRows = useMemo(
    () => sortTasksByPriority(boardWithoutPriority.filter((row) => !priorityFilter || row.priority === priorityFilter)),
    [boardWithoutPriority, priorityFilter],
  );
  const decisionRows = useMemo(() => rows.filter((row) => !!row.decision), [rows]);
  const readyRows = useMemo(() => rows.filter((row) => isTaskReadyNext(row)), [rows]);
  const activeRows = useMemo(() => rows.filter((row) => isTaskInProgress(row)), [rows]);
  const totalDecisions = useMemo(() => data?.tasks.filter((row) => !!row.decision).length ?? 0, [data?.tasks]);
  const totalReady = useMemo(() => data?.tasks.filter((row) => isTaskReadyNext(row)).length ?? 0, [data?.tasks]);
  const totalActive = useMemo(() => data?.tasks.filter((row) => isTaskInProgress(row)).length ?? 0, [data?.tasks]);
  const priorityBase = useMemo(() => {
    if (viewMode === "decisions") return listWithoutPriority.filter((row) => !!row.decision);
    if (viewMode === "ready") return listWithoutPriority.filter((row) => isTaskReadyNext(row));
    if (viewMode === "active") return listWithoutPriority.filter((row) => isTaskInProgress(row));
    if (viewMode === "board") return boardWithoutPriority;
    return listWithoutPriority;
  }, [boardWithoutPriority, listWithoutPriority, viewMode]);
  const priorityCounts = useMemo(() => {
    const counts = { "": priorityBase.length, high: 0, normal: 0, low: 0 };
    for (const row of priorityBase) {
      if (row.priority === "high") counts.high++;
      else if (row.priority === "low") counts.low++;
      else counts.normal++;
    }
    return counts;
  }, [priorityBase]);
  const people = useMemo(() => [...new Set(["user", ...agents.keys(), ...(data?.tasks.map((row) => row.owner).filter(Boolean) ?? [])])],
    [agents, data?.tasks]);
  const goalOptions = useMemo(() => data?.goals.map((row) => ({ value: row.id, label: `${row.id} · ${plainTaskTitle(row.title)}` })) ?? [], [data?.goals]);
  const taskOptions = useMemo(() => data?.tasks.map((row) => ({ value: row.id, label: `${row.id} · ${titleParts(row.title).heading}` })) ?? [], [data?.tasks]);
  const personOptions = people.map((value) => ({ value, label: value === "user" ? "USER" : value }));

  useEffect(() => {
    if (selected) detailRef.current?.scrollTo(0, 0);
    else listRef.current?.scrollTo(0, listScroll.current);
  }, [selected]);

  function choose(id: string) {
    if (!selected && id) listScroll.current = listRef.current?.scrollTop ?? 0;
    setSelected(id); setPage(0); setTab(id === "untagged" ? "discussion" : "overview"); setEvidence(undefined); setDetailError("");
    setPath(""); setTagId(""); setTagTarget("");
  }

  async function mutate(body: Record<string, unknown>, success?: string) {
    setBusy(true);
    try {
      const result = await request<{ export_warning?: string; item?: { id?: string } }>("/api/todo", body);
      await load();
      if (result.export_warning) toast.warning(result.export_warning);
      else if (success) toast.success(success);
      return result;
    } finally { setBusy(false); }
  }

  function act(body: Record<string, unknown>, success?: string) {
    return mutate(body, success).catch((cause: Error) => { toast.error(cause.message); return undefined; });
  }

  function handleChangePriority(taskId: string, priority: TaskPriority) {
    if (!admin || busy) return;
    const target = data?.tasks.find((row) => row.id === taskId);
    if (!target || (target.priority || "normal") === priority) return;
    void act(
      { action: "update", id: taskId, revision: target.revision, priority },
      `Priority set to ${PRIORITY_STYLE[priority].label}`,
    );
  }

  function enterAcrossView(mode: "goals" | "decisions" | "ready" | "active") {
    setGoalFilter("");
    setViewMode(mode);
  }

  function openGoalBoard(goalId: string) {
    setBoardGoal(goalId);
    setViewMode("board");
  }

  function clearViewFilters() {
    if (viewMode === "board") setBoardGoal("");
    else setGoalFilter("");
    setStateFilter("");
    setStageFilter("");
    setOwnerFilter("");
    setPriorityFilter("");
  }

  function openEditor(kind: Edit["kind"], value?: Goal | Task) {
    setEditError("");
    const item = value && "state" in value ? value : undefined;
    setEdit({
      kind, id: value?.id, revision: value?.revision,
      fields: kind === "goal" ? { title: value?.title ?? "" } : {
        title: item?.title ?? "", goal_id: item?.goal_id ?? (activeGoal || data?.goals[0]?.id || ""),
        state: item?.state ?? "todo", owner: item?.owner ?? "", priority: item?.priority ?? "normal",
        next_action: item?.next_action ?? "", blocker: item?.blocker ?? "", notes: item?.notes ?? "", decision: !!item?.decision,
      },
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || busy) return;
    const { goal_id, ...fields } = edit.fields;
    const goalEdit = edit.kind === "goal";
    const action = `${goalEdit ? "goal-" : ""}${edit.id ? "update" : "add"}`;
    try {
      const result = await mutate({ ...fields, action, id: edit.id, revision: edit.revision,
        ...(action === "add" ? { goal_id } : {}) }, goalEdit ? "Goal saved" : "Task saved");
      setEdit(undefined);
      if (!edit.id && result.item?.id) {
        if (goalEdit) setGoalFilter(result.item.id);
        else {
          if (typeof goal_id === "string") setGoalFilter(goal_id);
          choose(result.item.id);
        }
      }
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause));
      void load();
    }
  }

  const field = (key: string) => String(edit?.fields[key] ?? "");
  const change = (key: string, value: string | boolean) => setEdit((previous) => previous && {
    ...previous, fields: { ...previous.fields, [key]: value },
  });
  const currentRevision = edit?.id && (edit.kind === "goal"
    ? data?.goals.find((row) => row.id === edit.id)?.revision
    : data?.tasks.find((row) => row.id === edit.id)?.revision);
  const orderAvailable = !goalFilter && !stateFilter && !stageFilter && !ownerFilter && !priorityFilter && !search.trim() && viewMode === "goals";
  const groups = data?.goals.filter((row) => !goalFilter || goalFilter === row.id) ?? [];
  const detailOpen = !!selected;
  const anyFilter = !!(goalFilter || stateFilter || stageFilter || ownerFilter || priorityFilter || search.trim());
  const groupFilter = JSON.stringify([goalFilter, stateFilter, stageFilter, ownerFilter, priorityFilter, search.trim()]);
  const visibleGroupIds = groups
    .filter((group) => rows.some((row) => row.goal_id === group.id) || goalFilter === group.id)
    .map((group) => group.id);
  const defaultOpenGroups = goalFilter ? [goalFilter] : anyFilter ? visibleGroupIds : visibleGroupIds.slice(0, 1);
  const openGroups = expandedGroups?.filter === groupFilter ? expandedGroups.ids : defaultOpenGroups;
  const detail = task ? titleParts(task.title) : { heading: selected === "untagged" ? "Untagged" : "Task unavailable", rest: "" };
  const parsedDetail = task ? parseTaskStage(task.next_action) : null;
  const detailDocLinks = task ? extractTaskDocLinks([...(task.links ?? []), ...(evidence?.files ?? [])], task.id) : null;
  const withChoice = (label: string, options: SearchOption[]): SearchOption[] => [{ value: "", label }, ...options];

  const hasClearableFilters = !!(activeGoal || stateFilter || stageFilter || ownerFilter || priorityFilter);
  const dropdownFilterCount = (stateFilter ? 1 : 0) + (stageFilter ? 1 : 0) + (ownerFilter ? 1 : 0) + (viewMode !== "board" && goalFilter ? 1 : 0);
  const overallProgress = summarizeTaskProgress(data?.tasks ?? []);

  function renderDocFileItem(file: string, canUnlink: boolean) {
    const href = fileHref(file);
    if (!href) return null;
    const filename = file.split("/").at(-1) || file;
    return (
      <li key={file}>
        <Card size="sm" className="flex-row items-center justify-between gap-2 p-2">
          <Button variant="ghost" className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-2 whitespace-normal" onClick={() => openFile({ href, path: file })}>
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 text-left">
              <span className="block text-sm [overflow-wrap:anywhere]">{filename}</span>
              <span className="line-clamp-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{file}</span>
            </span>
          </Button>
          {task && canUnlink && (
            <Button size="sm" variant="ghost" className="h-10 touch:h-11"
              onClick={() => void act({ action: "unlink", id: task.id, path: file }, "Manual link removed")}>Unlink</Button>
          )}
          {!task && (
            <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={!linkTarget || busy}
              onClick={() => void act({ action: "link", id: linkTarget, path: file }, "File linked")}>Link</Button>
          )}
        </Card>
      </li>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b bg-card/40 px-3 py-2 sm:px-5">
        <h1 className="mr-auto text-lg font-semibold tracking-tight">Goals</h1>
        {admin && data && <>
          <Button size="sm" variant="outline" className="h-10 touch:h-11" onClick={() => openEditor("goal")}><Plus /> Goal</Button>
          <Button size="sm" className="h-10 touch:h-11" disabled={!data.goals.length} onClick={() => openEditor("task")}><Plus /> Task</Button>
        </>}
      </header>
      {error && <div role="alert" className="border-b px-3 py-2 text-sm text-destructive">{error}</div>}
      {data ? (
        <div className={cn("grid min-h-0 flex-1", detailOpen && "min-[900px]:grid-cols-[minmax(20rem,2fr)_minmax(0,3fr)]")}>
          <div ref={listRef} className={cn("min-h-0 min-w-0 overflow-y-auto", detailOpen && "hidden min-[900px]:block min-[900px]:border-r")}>
            <div className={cn("min-w-0 px-3 py-4 sm:px-5", viewMode === "board" && !detailOpen ? "w-full" : "mx-auto max-w-6xl")}>
              <div className="mb-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant={viewMode === "goals" ? "outline" : "ghost"} className={cn("h-10 touch:h-11", viewMode === "goals" && ACTIVE_FILTER_OUTLINE)} data-view-tab="goals"
                    onClick={() => enterAcrossView("goals")}>
                    <Target /> Goals <Badge variant="outline">{data.goals.length}</Badge>
                  </Button>
                  <Button size="sm" variant={viewMode === "decisions" ? "outline" : "ghost"} className={cn("h-10 touch:h-11", viewMode === "decisions" && ACTIVE_FILTER_OUTLINE)} data-view-tab="decisions"
                    onClick={() => enterAcrossView("decisions")}>
                    <TriangleAlert /> Needs your decision <Badge variant="outline">{totalDecisions}</Badge>
                  </Button>
                  <Button size="sm" variant={viewMode === "ready" ? "outline" : "ghost"} className={cn("h-10 touch:h-11", viewMode === "ready" && ACTIVE_FILTER_OUTLINE)} data-view-tab="ready"
                    onClick={() => enterAcrossView("ready")}>
                    <ListChecks /> Ready next <Badge variant="outline">{totalReady}</Badge>
                  </Button>
                  <Button size="sm" variant={viewMode === "active" ? "outline" : "ghost"} className={cn("h-10 touch:h-11", viewMode === "active" && ACTIVE_FILTER_OUTLINE)} data-view-tab="active"
                    onClick={() => enterAcrossView("active")}>
                    <Activity /> In progress <Badge variant="outline">{totalActive}</Badge>
                  </Button>
                  <Button size="sm" variant={viewMode === "board" ? "outline" : "ghost"} className={cn("h-10 touch:h-11", viewMode === "board" && ACTIVE_FILTER_OUTLINE)} data-view-tab="board"
                    onClick={() => setViewMode("board")}>
                    <Columns3 /> Stage board <Badge variant="outline">{boardRows.length}</Badge>
                  </Button>
                  <Button
                    size="icon"
                    variant="outline"
                    className={cn(
                      "size-10 touch:size-11",
                      (showFilters || dropdownFilterCount > 0)
                        ? ACTIVE_FILTER_OUTLINE
                        : "border-transparent bg-transparent hover:border-border/70 hover:bg-muted/60",
                    )}
                    aria-label="Filters"
                    aria-expanded={showFilters}
                    title="Filters"
                    onClick={() => setShowFilters((value) => !value)}
                  >
                    <ListFilter />
                  </Button>
                  {admin && <Button size="sm" variant="ghost" className="h-10 touch:h-11" onClick={() => choose("untagged")}><Tag /> Untagged</Button>}
                </div>
                <div role="group" aria-label="Filter by priority" className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Priority:</span>
                  {PRIORITY_FILTERS.map((opt) => {
                    const active = priorityFilter === opt.value;
                    const count = priorityCounts[opt.value];
                    const flagStyle = opt.value ? PRIORITY_STYLE[opt.value] : null;
                    return (
                      <Button
                        key={opt.value || "all"}
                        type="button"
                        size="xs"
                        variant="outline"
                        aria-pressed={active}
                        data-priority-filter={opt.value || "all"}
                        className={cn(
                          "h-7 gap-1 px-2 text-xs tabular-nums",
                          active ? ACTIVE_FILTER_OUTLINE : "border-border/80",
                        )}
                        onClick={() => setPriorityFilter(opt.value)}
                      >
                        {flagStyle && <Flag className={cn("size-3 shrink-0 fill-current", flagStyle.dotCls)} aria-hidden="true" />}
                        {opt.label}
                        <span className="text-muted-foreground">({count})</span>
                      </Button>
                    );
                  })}
                  {hasClearableFilters && (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      data-clear-filters="true"
                      className="ml-auto h-7 border-border/80 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={clearViewFilters}
                    >
                      Reset filters
                    </Button>
                  )}
                </div>
                <TaskProgressBar
                  dataAttr={{ "data-overall-progress": "true" }}
                  summary={overallProgress}
                  label="Overall task delivery progress"
                  className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2"
                />
              </div>
              {showFilters && <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 min-[900px]:grid-cols-2" aria-label="Task filters">
                <SearchableSelect
                  label="Filter by goal"
                  value={activeGoal}
                  onChange={(value) => (viewMode === "board" ? setBoardGoal(value) : setGoalFilter(value))}
                  options={withChoice("All goals", goalOptions)}
                  className={activeGoal ? ACTIVE_FILTER_OUTLINE : undefined}
                />
                <SearchableSelect
                  label="Filter by state"
                  value={stateFilter}
                  onChange={setStateFilter}
                  options={withChoice("Any state", stateOptions)}
                  className={stateFilter ? ACTIVE_FILTER_OUTLINE : undefined}
                />
                <SearchableSelect
                  label="Filter by stage"
                  value={stageFilter}
                  onChange={setStageFilter}
                  options={withChoice("Any stage", [...stageOptions, { value: "-", label: "No stage / malformed" }])}
                  className={stageFilter ? ACTIVE_FILTER_OUTLINE : undefined}
                />
                <SearchableSelect
                  label="Filter by owner"
                  value={ownerFilter}
                  onChange={setOwnerFilter}
                  options={withChoice("Any owner", [{ value: "-", label: "Unassigned" }, ...personOptions])}
                  className={ownerFilter ? ACTIVE_FILTER_OUTLINE : undefined}
                />
              </div>}
              {viewMode === "board" ? (
                <>
                  <div className="mb-3 space-y-2">
                    <div role="group" aria-label="Filter stage board by goal" className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        aria-pressed={!boardGoal}
                        data-board-goal=""
                        className={cn(
                          "h-7 px-2 text-xs",
                          !boardGoal
                            ? "border-primary bg-primary/15 font-medium text-foreground ring-1 ring-primary/40"
                            : "border-border/80",
                        )}
                        onClick={() => setBoardGoal("")}
                      >
                        All goals ({data.tasks.length})
                      </Button>
                      {data.goals.map((g) => (
                        <Button
                          key={g.id}
                          type="button"
                          size="xs"
                          variant="outline"
                          aria-pressed={boardGoal === g.id}
                          data-board-goal={g.id}
                          className={cn(
                            "h-7 px-2 font-mono text-xs",
                            boardGoal === g.id
                              ? "border-primary bg-primary/15 font-medium text-foreground ring-1 ring-primary/40"
                              : "border-border/80",
                          )}
                          onClick={() => setBoardGoal(boardGoal === g.id ? "" : g.id)}
                        >
                          {g.id}
                        </Button>
                      ))}
                    </div>
                    {goal && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          Showing <span className="font-mono font-medium text-foreground">{goal.id}</span> · {plainTaskTitle(goal.title)}
                        </p>
                        <TaskProgressBar
                          dataAttr={{ "data-board-goal-progress": goal.id }}
                          summary={summarizeTaskProgress(data.tasks.filter((row) => row.goal_id === goal.id))}
                          label={`${goal.id} progress`}
                          compact
                        />
                      </div>
                    )}
                  </div>
                  {!boardRows.length && <Card size="sm" className="mb-3"><CardContent className={textClass}>No tasks match.</CardContent></Card>}
                  <GoalsBoard tasks={boardRows} selectedId={selected} admin={admin} busy={busy} onSelect={choose} onChangePriority={handleChangePriority} />
                </>
              ) : viewMode === "decisions" ? (
                <div className="space-y-3" data-view-panel="decisions">
                  <p className={textClass}>Tasks waiting on a USER decision across all goals, sorted by priority.</p>
                  {decisionRows.length > 0 ? (
                    <ul className="space-y-2.5 p-0.5">
                      {decisionRows.map((row) => (
                        <li key={row.id}>
                          <TaskRowCard task={row} selected={selected === row.id} showGoalBadge admin={admin} busy={busy} onSelect={choose} onChangePriority={handleChangePriority} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Card size="sm"><CardContent className={textClass}>No tasks waiting on a USER decision match the current filters.</CardContent></Card>
                  )}
                </div>
              ) : viewMode === "ready" ? (
                <div className="space-y-3" data-view-panel="ready">
                  <p className={textClass}>Tasks ready to start across all goals (to-do tasks not held on a USER decision), sorted by priority.</p>
                  {readyRows.length > 0 ? (
                    <ul className="space-y-2.5 p-0.5">
                      {readyRows.map((row) => (
                        <li key={row.id}>
                          <TaskRowCard task={row} selected={selected === row.id} showGoalBadge admin={admin} busy={busy} onSelect={choose} onChangePriority={handleChangePriority} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Card size="sm"><CardContent className={textClass}>No ready-to-start tasks match the current filters.</CardContent></Card>
                  )}
                </div>
              ) : viewMode === "active" ? (
                <div className="space-y-3" data-view-panel="active">
                  <p className={textClass}>Active work in progress across all goals (in-progress tasks not held on a USER decision), sorted by priority.</p>
                  {activeRows.length > 0 ? (
                    <ul className="space-y-2.5 p-0.5">
                      {activeRows.map((row) => (
                        <li key={row.id}>
                          <TaskRowCard task={row} selected={selected === row.id} showGoalBadge admin={admin} busy={busy} onSelect={choose} onChangePriority={handleChangePriority} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Card size="sm"><CardContent className={textClass}>No active tasks in progress match the current filters.</CardContent></Card>
                  )}
                </div>
              ) : (
                <div className="space-y-3" data-view-panel="goals">
                  <Accordion
                    multiple
                    value={openGroups}
                    onValueChange={(ids) => setExpandedGroups({ filter: groupFilter, ids })}
                    aria-label="Tasks by goal"
                    className="space-y-2.5"
                  >
                    {groups.map((group) => {
                      const items = rows.filter((row) => row.goal_id === group.id);
                      if (!items.length && !goal) return null;
                      const allInGoal = data.tasks.filter((row) => row.goal_id === group.id);
                      const goalProgress = summarizeTaskProgress(allInGoal);
                      const blockedCount = allInGoal.filter((row) => row.state === "blocked").length;
                      return (
                        <AccordionItem key={group.id} value={group.id} data-goal-section={group.id} className="rounded-xl border border-border/80 bg-card ring-0">
                          <div className="flex flex-wrap items-center gap-1 pr-2">
                            <AccordionTrigger className="min-w-0 flex-1">
                              <Badge variant="outline" className="font-mono">{group.id}</Badge>
                              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{plainTaskTitle(group.title)}</span>
                              {blockedCount > 0 && (
                                <Badge variant="secondary" className={cn("tabular-nums", GOAL_STATE_STYLE.blocked.cls)}>
                                  {blockedCount} blocked
                                </Badge>
                              )}
                              <Badge variant="secondary" className="tabular-nums" aria-label={`${items.length} tasks`}>{items.length}</Badge>
                            </AccordionTrigger>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              data-open-goal-board={group.id}
                              title={`Open ${group.id} 6-stage board`}
                              className="h-8 gap-1 px-2 text-xs"
                              onClick={() => openGoalBoard(group.id)}
                            >
                              <Columns3 className="size-3.5" aria-hidden="true" />
                              <span className="hidden sm:inline">Stage board</span>
                            </Button>
                            {admin && (
                              <DropdownMenu>
                                <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="size-9 touch:size-11" aria-label={`Actions for ${group.id}`}><MoreHorizontal /></Button>} />
                                <DropdownMenuContent align="end" className="w-40">
                                  <DropdownMenuItem className="touch:min-h-11" onClick={() => openEditor("goal", group)}>Rename goal</DropdownMenuItem>
                                  <DropdownMenuItem className="touch:min-h-11" variant="destructive"
                                    onClick={() => setRemove({ goal: group, count: allInGoal.length })}>Remove goal</DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                          <div className="px-3 pb-2">
                            <TaskProgressBar
                              dataAttr={{ "data-goal-progress": group.id }}
                              summary={goalProgress}
                              label={`${group.id} delivery progress`}
                              compact
                            />
                          </div>
                          <AccordionContent className="space-y-2.5 px-3 pt-1 pb-3">
                            {items.length > 0 ? (
                              <ul className="space-y-2.5 p-0.5">
                                {items.map((row) => (
                                  <li key={row.id}>
                                    <TaskRowCard
                                      task={row}
                                      selected={selected === row.id}
                                      admin={admin}
                                      busy={busy}
                                      onSelect={choose}
                                      onChangePriority={handleChangePriority}
                                    />
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="px-1 py-2 text-xs text-muted-foreground">No matching tasks in {group.id}.</p>
                            )}
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                    {!rows.length && <Card size="sm"><CardContent className={textClass}>No tasks match.</CardContent></Card>}
                  </Accordion>
                </div>
              )}
            </div>
          </div>
          {detailOpen && <div ref={detailRef} className="min-h-0 min-w-0 overflow-y-auto bg-muted/20 p-3 sm:p-5">
            <div className="mx-auto max-w-3xl space-y-4">
              <Card>
                <CardHeader>
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Button size="icon" variant="ghost" className="-ml-2 size-10 touch:size-11 min-[900px]:hidden" aria-label="Back to goals" onClick={() => choose("")}><ArrowLeft /></Button>
                    {task ? <>
                      <Badge variant="outline" className="font-mono">{task.id}</Badge>
                      {!shouldHideStateBadge(task.state, parsedDetail?.stage ?? null) && <StateBadge task={task} />}
                      <DecisionBadge decision={task.decision} />
                      <StageBadge stage={parsedDetail?.stage ?? null} parsed={parsedDetail ?? undefined} />
                      <PriorityFlagControl
                        task={task}
                        admin={admin}
                        disabled={busy}
                        onChangePriority={handleChangePriority}
                      />
                      <Badge variant="outline">{task.owner === "user" ? "USER" : task.owner || "Unassigned"}</Badge>
                    </> : <Badge variant="secondary"><Tag /> Triage</Badge>}
                    <Button size="icon" variant="ghost" className="ml-auto hidden size-9 min-[900px]:inline-flex" aria-label="Close task details" title="Close details" onClick={() => choose("")}><X /></Button>
                  </div>
                  <CardTitle className="text-lg [overflow-wrap:anywhere] sm:text-xl">{detail.heading}</CardTitle>
                </CardHeader>
                {task && admin && <CardContent className="flex flex-wrap items-center gap-2">
                  <Button size="sm" className="h-10 touch:h-11" title="Update the owner, state, priority, next action, blocker, notes, or decision flag" onClick={() => openEditor("task", task)}>Edit task</Button>
                  {task.state !== "done" && !task.decision && <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={busy}
                    onClick={() => void act({ action: "update", id: task.id, revision: task.revision, state: "done" }, "Task marked done")}><CircleCheck /> Mark done</Button>}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="icon" variant="outline" className="ml-auto size-10 touch:size-11" aria-label="Task actions"><MoreHorizontal /></Button>} />
                    <DropdownMenuContent align="end" className="w-44">
                      {([["up", ArrowUp], ["down", ArrowDown], ["top", ArrowUpToLine]] as const).map(([direction, Icon]) =>
                        <DropdownMenuItem key={direction} disabled={busy || !orderAvailable} className="touch:min-h-11"
                          onClick={() => void act({ action: "move", id: task.id, direction, order_revision: data.order_revision })}><Icon /> Move {direction}</DropdownMenuItem>)}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" className="touch:min-h-11" onClick={() => setRemove({ goal: task })}>Remove task</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardContent>}
              </Card>
              <Tabs value={admin ? tab : "overview"} onValueChange={(value) => { setTab(String(value)); setPage(0); setTagId(""); }}>
                {admin && (
                  <TabsList aria-label="Task details" className="w-full justify-stretch sm:w-fit">
                    {task && <TabsTrigger value="overview" className="min-h-10 flex-1 px-2 touch:min-h-11 sm:px-3">Overview</TabsTrigger>}
                    <TabsTrigger value="discussion" className="min-h-10 flex-1 px-2 touch:min-h-11 sm:px-3"><MessageSquare className="hidden sm:block" /> Discussion</TabsTrigger>
                    <TabsTrigger value="documents" className="min-h-10 flex-1 px-2 touch:min-h-11 sm:px-3"><FileText className="hidden sm:block" /> Documents</TabsTrigger>
                  </TabsList>
                )}
                {task && <TabsContent value="overview" className="space-y-3">
                  {[
                    ["Next action", task.next_action],
                    ["Blocker", task.blocker],
                    ["Notes", task.notes],
                    ["Context", detail.rest],
                  ].map(([label, value]) => value && <Card key={label} size="sm">
                    <CardHeader><CardTitle>{label}</CardTitle></CardHeader>
                    <CardContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</CardContent>
                  </Card>)}
                  {!task.next_action && !task.blocker && !task.notes && !detail.rest &&
                    <Card size="sm"><CardContent className={textClass}>No next action or notes yet.</CardContent></Card>}
                </TabsContent>}
                {detailError && <p role="alert" className="text-sm text-destructive">{detailError}</p>}
                {admin && <TabsContent value="discussion" className="space-y-3">
                  {task && <div className="flex justify-end">
                    <Button size="sm" variant="outline" className="h-10 touch:h-11" title={`Start mail with ${task.id} filled in as the task ID`}
                      onClick={() => startCompose("new", null, { taskId: task.id })}>
                      <Plus /> New message
                    </Button>
                  </div>}
                  {selected === "untagged" && <p className={textClass}>Use the tag button beside a message to choose its task, then save the tag.</p>}
                  {tagId && <Card size="sm">
                    <CardHeader><CardTitle>Tag {tagId}</CardTitle></CardHeader>
                    <CardContent>
                      <form className="grid grid-cols-2 gap-2" onSubmit={(event) => {
                        event.preventDefault();
                        void act({ action: "tag", event_id: tagId, id: tagTarget || null }, "Message tag saved").then((result) => { if (result) setTagId(""); });
                      }}>
                        <SearchableSelect label="Task tag" className="col-span-2" value={tagTarget} onChange={setTagTarget} options={withChoice("Clear tag", taskOptions)} />
                        <Button size="sm" className="h-10 touch:h-11" variant="outline" type="button" onClick={() => setTagId("")}>Cancel</Button>
                        <Button type="submit" size="sm" className="h-10 touch:h-11" disabled={busy}>Save tag</Button>
                      </form>
                    </CardContent>
                  </Card>}
                  {!evidence?.events.length && <Card size="sm">
                    <CardContent className={textClass}>{evidence
                      ? task ? `No messages tagged ${task.id} yet. New message fills in the task ID for you.` : "No recent untagged messages."
                      : "Loading discussion…"}</CardContent>
                  </Card>}
                  <ul className="space-y-2">
                    {evidence?.events.map((row) => <li key={row.id}>
                      <Card size="sm" className="flex-row items-center justify-between gap-2 p-2">
                        <Button variant="ghost" className="h-auto min-h-11 min-w-0 flex-1 justify-start whitespace-normal"
                          disabled={row.type === "agent.status"} onClick={() => openEvent(row.id)}>
                          <span className="min-w-0 text-left">
                            <span className="flex flex-wrap gap-1.5">
                              <Badge variant="ghost" className="px-0 font-mono">{row.id}</Badge>
                              <Badge variant="outline">{row.from === "user" ? "USER" : row.from}</Badge>
                              {row.task_id && <Badge variant="outline">{row.task_id}</Badge>}
                            </span>
                            <span className="line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere]">{row.subject ?? row.excerpt}</span>
                          </span>
                        </Button>
                        {row.type !== "agent.status" && <Button size="icon" variant="ghost" className="size-10 shrink-0 touch:size-11"
                          aria-label={`Tag message ${row.id}`} title="Set tag" onClick={() => { setTagId(row.id); setTagTarget(task?.id ?? ""); }}><Tag /></Button>}
                      </Card>
                    </li>)}
                  </ul>
                </TabsContent>}
                {admin && <TabsContent value="documents" className="space-y-3">
                  {task ? <Card size="sm">
                    <CardContent className="space-y-3">
                      <form className="flex flex-wrap gap-2" onSubmit={(event) => {
                        event.preventDefault();
                        void act({ action: "link", id: task.id, path }, "File linked").then((result) => { if (result) setPath(""); });
                      }}>
                        <Input className="h-11 min-w-0 flex-1 text-base sm:h-9 sm:text-sm" aria-label="Repository file path" placeholder="Repository file path"
                          value={path} onChange={(event) => setPath(event.target.value)} />
                        <Button type="submit" size="sm" className="h-11 sm:h-9" title="Link an existing file by its repository-relative path"
                          disabled={busy || !path.trim()}><Link2 /> Link</Button>
                      </form>
                      <p className={textClass}>Link an existing repository file, or upload a copy to Mailroom attachments.</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={busy} onClick={() => uploadRef.current?.click()}>
                          <Upload /> Upload to task
                        </Button>
                        {detailDocLinks && (
                          <>
                            <OpenFolderAction
                              admin={admin}
                              folders={detailDocLinks.ownedFolders}
                              onOpenFolder={setBrowseFolder}
                              size="sm"
                              label="Browse folder"
                            />
                            <CopyFolderPathAction
                              admin={admin}
                              folders={detailDocLinks.ownedFolders}
                              size="sm"
                            />
                          </>
                        )}
                      </div>
                      <Input type="file" ref={uploadRef} hidden disabled={busy} onChange={async (event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (!file) return;
                        setBusy(true);
                        try {
                          const result = await api.uploadAttachment(file, file.name, task.id);
                          if (result.link_warning || result.export_warning) toast.warning(result.link_warning || result.export_warning);
                          else toast.success("File uploaded and linked");
                          await load();
                        } catch (cause) { toast.error(String(cause)); }
                        finally { setBusy(false); }
                      }} />
                    </CardContent>
                  </Card> : <>
                    <p className={textClass}>Choose the task, then select Link beside a document.</p>
                    <SearchableSelect label="Task for untagged documents" value={linkTarget} onChange={setLinkTarget} options={withChoice("Choose a task", taskOptions)} />
                  </>}
                  {!evidence?.files.length && <Card size="sm">
                    <CardContent className={textClass}>{evidence
                      ? task ? `No documents linked to ${task.id} yet. File attachments on tagged messages also appear here.` : "No recent untagged documents."
                      : "Loading documents…"}</CardContent>
                  </Card>}
                  {!!evidence?.files.length && (
                    <ul className="space-y-2">
                      {evidence.files.map((file) => renderDocFileItem(file, !!task && evidence.manual_files.includes(file)))}
                    </ul>
                  )}
                </TabsContent>}
                {tab !== "overview" && (page > 0 || (page + 1) * pageSize < (tab === "discussion" ? evidence?.total ?? 0 : evidence?.file_total ?? 0)) && (
                  <div className="flex justify-between">
                    <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button>
                    <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={(page + 1) * pageSize >= (tab === "discussion" ? evidence?.total ?? 0 : evidence?.file_total ?? 0)} onClick={() => setPage(page + 1)}>Next</Button>
                  </div>
                )}
              </Tabs>
            </div>
          </div>}
        </div>
      ) : !error && <p className="p-4 text-sm text-muted-foreground">Loading goals…</p>}
      <Dialog open={!!edit} onOpenChange={(open) => { if (!open && !busy) setEdit(undefined); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{edit?.id ? `Edit ${edit.id}` : edit?.kind === "goal" ? "New goal" : "New task"}</DialogTitle></DialogHeader>
          <form className="space-y-3" onSubmit={submit}>
            {edit?.kind === "task" && !edit.id && <div className="grid gap-1">
              <span className="text-sm font-medium">Goal</span>
              <SearchableSelect label="Goal" value={field("goal_id")} onChange={(value) => change("goal_id", value)} options={goalOptions} />
            </div>}
            <label className="grid gap-1">Title
              {edit?.kind === "task" ? <Textarea required maxLength={800} rows={2} className="text-base sm:text-sm"
                value={field("title")} onChange={(event) => change("title", event.target.value.replace(/[\r\n]+/g, " "))} />
                : <Input required maxLength={800} className="h-11 text-base sm:h-9 sm:text-sm" value={field("title")} onChange={(event) => change("title", event.target.value)} />}
            </label>
            {edit?.kind === "task" && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="grid min-w-0 gap-1"><span>State</span>
                  <SearchableSelect label="State" value={edit.fields.decision ? "blocked" : field("state")} options={stateOptions}
                    disabled={!!edit.fields.decision} onChange={(value) => change("state", value)} />
                </div>
                <div className="grid min-w-0 gap-1"><span>Owner</span>
                  <SearchableSelect label="Owner" value={field("owner")} onChange={(value) => change("owner", value)} options={withChoice("Unassigned", personOptions)} />
                </div>
                <div className="grid min-w-0 gap-1"><span>Priority</span>
                  <SearchableSelect label="Priority" value={field("priority")} options={priorities} onChange={(value) => change("priority", value)} />
                </div>
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <Checkbox aria-label="Requires a USER decision" checked={!!edit.fields.decision} onCheckedChange={(checked) => change("decision", checked)} />
                Requires a USER decision
              </label>
              {([["next_action", "Next action", 2000], ["blocker", "Blocker", 2000], ["notes", "Notes", 8000]] as const).map(([key, label, limit]) => (
                <label key={key} className="grid gap-1">{label}<Textarea rows={2} maxLength={limit} className="text-base sm:text-sm" value={field(key)} onChange={(event) => change(key, event.target.value)} /></label>
              ))}
            </>}
            {editError && <p role="alert" className="text-sm text-destructive">{editError}</p>}
            {edit?.id && currentRevision && currentRevision !== edit.revision && <div className="space-y-2 rounded-md border p-2 text-sm">
              <p>Current revision is {currentRevision}. Your draft is still in the form.</p>
              <details><summary>Compare with current values</summary><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(edit.kind === "goal" ? data?.goals.find((row) => row.id === edit.id) : data?.tasks.find((row) => row.id === edit.id), null, 2)}</pre></details>
              <Button type="button" size="sm" variant="outline" onClick={() => { setEdit({ ...edit, revision: Number(currentRevision) }); setEditError(""); }}>Apply my draft to current revision</Button>
            </div>}
            <DialogFooter><Button type="submit" className="h-11 sm:h-9" disabled={busy || !field("title").trim() || (edit?.kind === "task" && !edit.id && !field("goal_id"))}>Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!remove} onOpenChange={(open) => { if (!open && !busy) setRemove(undefined); }}>
        <AlertDialogContent>
          <AlertDialogTitle>Remove {remove?.goal.id}?</AlertDialogTitle>
          <AlertDialogDescription>{remove?.count === undefined ? "The task is removed from the active list." : `The goal and its ${remove.count} active tasks are removed from the active list.`} Linked mail and files remain available.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => {
              if (!remove) return;
              const goalRemoval = remove.count !== undefined;
              void act({ action: goalRemoval ? "goal-remove" : "remove", id: remove.goal.id, revision: remove.goal.revision, confirm_count: remove.count }, goalRemoval ? "Goal removed" : "Task removed")
                .then((result) => { if (result) { if (goalRemoval) { setGoalFilter(""); setBoardGoal(""); } choose(""); setRemove(undefined); } });
            }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <RepoFolderDialog
        open={!!browseFolder}
        rootPath={browseFolder?.folder ?? ""}
        title={browseFolder?.label}
        onOpenChange={(open) => { if (!open) setBrowseFolder(null); }}
        onOpenFile={openFile}
      />
    </div>
  );
}
