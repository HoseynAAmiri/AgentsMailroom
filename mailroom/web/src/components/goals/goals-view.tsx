"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpToLine, ChevronRight, CircleCheck, FileText, Link2, ListFilter, MessageSquare, MoreHorizontal, Plus, Tag, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GoalSelect, type GoalOption } from "./goal-select";
import { useBackLayer } from "@/hooks/use-back-layer";
import { api, fileHref } from "@/lib/api";
import { GOAL_STATE_STYLE, plainTaskTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMailroom } from "@/components/mailroom/context";

type State = "todo" | "doing" | "blocked" | "done";
type Priority = "high" | "normal" | "low";
interface Goal { id: string; title: string; revision: number }
interface Task extends Goal {
  goal_id: string;
  state: State;
  priority: Priority;
  owner: string;
  next_action: string;
  blocker: string;
  notes: string;
  decision: number;
}
interface Tracker { goals: Goal[]; tasks: Task[]; order_revision: number; revision: number }
interface Evidence {
  events: { id: string; from: string; subject?: string; task_id?: string; excerpt: string; type: string }[];
  files: string[];
  manual_files: string[];
  total: number;
  file_total: number;
}
type Edit = { kind: "goal" | "task"; id?: string; revision?: number; fields: Record<string, string | boolean> };
const textClass = "text-sm text-muted-foreground";
const pageSize = 30;
const stateOptions = Object.entries(GOAL_STATE_STYLE).map(([value, { label }]) => ({ value, label }));
const priorities = ["high", "normal", "low"].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

function titleParts(title: string) {
  const plain = plainTaskTitle(title);
  const end = plain.search(/[.!?]\s+(?=[A-Z])/);
  return end < 0 ? { heading: plain, rest: "" } : { heading: plain.slice(0, end + 1), rest: plain.slice(end + 1).trim() };
}

function StateBadge({ task }: { task: Task }) {
  return <Badge variant="secondary" className={GOAL_STATE_STYLE[task.state].cls}>
    {task.state === "done" && <CircleCheck data-icon="inline-start" aria-hidden="true" />}
    {task.decision ? "USER decision" : GOAL_STATE_STYLE[task.state].label}
  </Badge>;
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
  const [stateFilter, setStateFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [decisionsOnly, setDecisionsOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<{ filter: string; ids: string[] }>();
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
    void load(controller.signal);
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

  const goal = data?.goals.find((row) => row.id === goalFilter);
  const task = data?.tasks.find((row) => row.id === selected);
  const rows = useMemo(() => data?.tasks.filter((row) => {
    const query = search.trim().toLowerCase();
    return (!goalFilter || row.goal_id === goalFilter)
      && (!decisionsOnly || !!row.decision)
      && (!stateFilter || row.state === stateFilter)
      && (!ownerFilter || row.owner === (ownerFilter === "-" ? "" : ownerFilter))
      && (!priorityFilter || row.priority === priorityFilter)
      && (!query || [row.id, row.title, row.notes, row.next_action].some((value) => value.toLowerCase().includes(query)));
  }) ?? [], [data, goalFilter, stateFilter, ownerFilter, priorityFilter, search, decisionsOnly]);
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

  function openEditor(kind: Edit["kind"], value?: Goal | Task) {
    setEditError("");
    const item = value && "state" in value ? value : undefined;
    setEdit({
      kind, id: value?.id, revision: value?.revision,
      fields: kind === "goal" ? { title: value?.title ?? "" } : {
        title: item?.title ?? "", goal_id: item?.goal_id ?? (goalFilter || data?.goals[0]?.id || ""),
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
  const orderAvailable = !stateFilter && !ownerFilter && !priorityFilter && !search.trim() && !decisionsOnly;
  const groups = data?.goals.filter((row) => !goalFilter || goalFilter === row.id) ?? [];
  const detailOpen = !!selected;
  const showOverview = !goalFilter && !showAll && orderAvailable;
  const groupFilter = JSON.stringify([goalFilter, stateFilter, ownerFilter, priorityFilter, search.trim(), decisionsOnly]);
  const visibleGroupIds = [...new Set(rows.map((row) => row.goal_id))];
  const openGroups = expandedGroups?.filter === groupFilter
    ? expandedGroups.ids : goalFilter ? [goalFilter] : orderAvailable ? visibleGroupIds.slice(0, 1) : visibleGroupIds;
  const detail = task ? titleParts(task.title) : { heading: selected === "untagged" ? "Untagged" : "Task unavailable", rest: "" };
  const withChoice = (label: string, options: GoalOption[]): GoalOption[] => [{ value: "", label }, ...options];

  function backToOverview() {
    setGoalFilter(""); setStateFilter(""); setOwnerFilter(""); setPriorityFilter(""); setDecisionsOnly(false); setShowAll(false);
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
        <div className={cn("grid min-h-0 flex-1", detailOpen && "min-[900px]:grid-cols-[minmax(19rem,2fr)_minmax(0,3fr)]")}>
          <div ref={listRef} className={cn("min-h-0 min-w-0 overflow-y-auto", detailOpen && "hidden min-[900px]:block min-[900px]:border-r")}>
            <div className="mx-auto max-w-6xl px-3 py-4 sm:px-5">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={showOverview ? "secondary" : "ghost"} className="h-10 touch:h-11" onClick={backToOverview}>
                  Overview
                </Button>
                <Button size="sm" variant={!showOverview && !goalFilter && !decisionsOnly ? "secondary" : "ghost"} className="h-10 touch:h-11"
                  onClick={() => { setGoalFilter(""); setDecisionsOnly(false); setShowAll(true); }}>
                  All tasks <Badge variant="outline">{data.tasks.length}</Badge>
                </Button>
                <Button size="sm" variant={decisionsOnly ? "secondary" : "ghost"} className="h-10 touch:h-11" aria-pressed={decisionsOnly}
                  onClick={() => {
                    setGoalFilter(""); setStateFilter(""); setOwnerFilter(""); setPriorityFilter("");
                    setDecisionsOnly((value) => !value);
                  }}>
                  <TriangleAlert /> USER decisions <Badge variant="outline">{data.tasks.filter((row) => row.decision).length}</Badge>
                </Button>
                <Button size="icon" variant={showFilters ? "secondary" : "ghost"} className="size-10 touch:size-11" aria-label="Filters" aria-expanded={showFilters}
                  title="Filters" onClick={() => setShowFilters((value) => !value)}><ListFilter /></Button>
                {admin && <Button size="sm" variant="ghost" className="h-10 touch:h-11" onClick={() => choose("untagged")}><Tag /> Untagged</Button>}
              </div>
              {showOverview && <Card size="sm" className="mb-4">
                <CardHeader><CardTitle>How to use Goals</CardTitle></CardHeader>
                <CardContent className={textClass}>
                  Open a goal, then choose a task. <strong>Overview</strong> shows its status and next action.{" "}
                  {admin && <>Use <strong>Edit task</strong> to update them, <strong>Discussion</strong> to read or start mail tagged
                    with that task ID, and <strong>Documents</strong> to open, link, or upload files. Use <strong>Untagged</strong> to
                    assign recent mail and files that still need a task.</>}
                </CardContent>
              </Card>}
              {showFilters && <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 min-[900px]:grid-cols-2" aria-label="Task filters">
                <GoalSelect label="Filter by goal" value={goalFilter} onChange={setGoalFilter} options={withChoice("All goals", goalOptions)} />
                <GoalSelect label="Filter by state" value={stateFilter} onChange={setStateFilter} options={withChoice("Any state", stateOptions)} />
                <GoalSelect label="Filter by owner" value={ownerFilter} onChange={setOwnerFilter}
                  options={withChoice("Any owner", [{ value: "-", label: "Unassigned" }, ...personOptions])} />
                <GoalSelect label="Filter by priority" value={priorityFilter} onChange={setPriorityFilter} options={withChoice("Any priority", priorities)} />
              </div>}
              {showOverview ? <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", detailOpen ? "min-[900px]:grid-cols-1" : "xl:grid-cols-3")}>
                {data.goals.map((group) => {
                  const items = data.tasks.filter((row) => row.goal_id === group.id);
                  const done = items.filter((row) => row.state === "done").length;
                  const blocked = items.filter((row) => row.state === "blocked").length;
                  return <Card className="relative border border-transparent shadow-sm hover:border-primary/40" key={group.id}>
                    <Button variant="ghost" aria-label={`Open ${group.id} ${group.title}`} className="absolute inset-0 z-10 size-full bg-transparent hover:bg-primary/5"
                      onClick={() => setGoalFilter(group.id)} />
                    <CardHeader className="gap-2">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="font-mono text-muted-foreground">{group.id}</Badge>
                        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                      <CardTitle className="text-balance">{plainTaskTitle(group.title)}</CardTitle>
                    </CardHeader>
                    <CardContent className="mt-auto space-y-2">
                      <Progress value={items.length ? 100 * done / items.length : 0} aria-label={`${done} of ${items.length} tasks done`} />
                      <CardDescription className="flex items-center justify-between gap-2 tabular-nums">
                        <span>{done} of {items.length} done</span>
                        {!!blocked && <Badge variant="secondary" className={GOAL_STATE_STYLE.blocked.cls}>{blocked} blocked</Badge>}
                      </CardDescription>
                    </CardContent>
                  </Card>;
                })}
              </div> : <Accordion multiple value={openGroups} onValueChange={(ids) => setExpandedGroups({ filter: groupFilter, ids })}
                aria-label="Tasks by goal" className="space-y-2.5">
                {groups.map((group) => {
                  const items = rows.filter((row) => row.goal_id === group.id);
                  if (!items.length && !goal) return null;
                  return <AccordionItem key={group.id} value={group.id} className="rounded-xl bg-card ring-1 ring-foreground/10">
                    <div className="flex items-center gap-1">
                      <AccordionTrigger>
                        <Badge variant="outline" className="font-mono">{group.id}</Badge>
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{plainTaskTitle(group.title)}</span>
                        <Badge variant="secondary" aria-label={`${items.length} tasks`}>{items.length}</Badge>
                      </AccordionTrigger>
                      {admin && openGroups.includes(group.id) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger render={<Button size="icon" variant="ghost" className="mr-1 size-10 touch:size-11" aria-label={`Actions for ${group.id}`}><MoreHorizontal /></Button>} />
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem className="touch:min-h-11" onClick={() => openEditor("goal", group)}>Rename goal</DropdownMenuItem>
                            <DropdownMenuItem className="touch:min-h-11" variant="destructive"
                              onClick={() => setRemove({ goal: group, count: data.tasks.filter((row) => row.goal_id === group.id).length })}>Remove goal</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                    <AccordionContent>
                    <ul className="space-y-2">
                      {items.map((row) => <li key={row.id}>
                        <Card size="sm" className={cn(
                          "gap-0 py-0 shadow-none",
                          row.state === "done" && "bg-muted/35 ring-foreground/5",
                          selected === row.id && "bg-primary/8 ring-primary/50",
                        )}>
                          <Button type="button" variant="ghost" onClick={() => choose(row.id)} aria-current={selected === row.id ? "true" : undefined}
                            className="h-auto min-h-16 w-full min-w-0 justify-between gap-3 rounded-xl px-3 py-2.5 text-left whitespace-normal touch:py-3">
                            <span className="min-w-0 flex-1 space-y-1.5">
                              <span className="flex flex-wrap items-center gap-1.5">
                                <Badge variant="ghost" className="px-0 font-mono text-muted-foreground">{row.id}</Badge>
                                <StateBadge task={row} />
                                {row.priority !== "normal" && <Badge variant="outline">{row.priority === "high" ? "High priority" : "Low priority"}</Badge>}
                                {row.owner && <Badge variant="outline">{row.owner === "user" ? "USER" : row.owner}</Badge>}
                              </span>
                              <span className={cn(
                                "line-clamp-2 block text-sm leading-snug [overflow-wrap:anywhere]",
                                row.state === "done" && selected !== row.id ? "font-normal text-muted-foreground" : "font-medium",
                              )}>{titleParts(row.title).heading}</span>
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          </Button>
                        </Card>
                      </li>)}
                    </ul>
                    </AccordionContent>
                  </AccordionItem>;
                })}
                {!rows.length && <Card size="sm"><CardContent className={textClass}>No tasks match.</CardContent></Card>}
              </Accordion>}
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
                      <StateBadge task={task} />
                      <Badge variant="outline">{task.priority} priority</Badge>
                      <Badge variant="outline">{task.owner === "user" ? "USER" : task.owner || "Unassigned"}</Badge>
                    </> : <Badge variant="secondary"><Tag /> Triage</Badge>}
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
                        <GoalSelect label="Task tag" className="col-span-2" value={tagTarget} onChange={setTagTarget} options={withChoice("Clear tag", taskOptions)} />
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
                      <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={busy} onClick={() => uploadRef.current?.click()}>
                        <Upload /> Upload to task
                      </Button>
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
                    <GoalSelect label="Task for untagged documents" value={linkTarget} onChange={setLinkTarget} options={withChoice("Choose a task", taskOptions)} />
                  </>}
                  {!evidence?.files.length && <Card size="sm">
                    <CardContent className={textClass}>{evidence
                      ? task ? `No documents linked to ${task.id} yet. File attachments on tagged messages also appear here.` : "No recent untagged documents."
                      : "Loading documents…"}</CardContent>
                  </Card>}
                  <ul className="space-y-2">
                    {evidence?.files.map((file) => {
                      const href = fileHref(file);
                      const filename = file.split("/").at(-1);
                      return href && <li key={file}>
                        <Card size="sm" className="flex-row items-center justify-between gap-2 p-2">
                          <Button variant="ghost" className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-2 whitespace-normal" onClick={() => openFile({ href, path: file })}>
                            <FileText className="size-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 text-left">
                              <span className="block text-sm [overflow-wrap:anywhere]">{filename}</span>
                              <span className="line-clamp-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{file}</span>
                            </span>
                          </Button>
                          {task && evidence.manual_files.includes(file) && <Button size="sm" variant="ghost" className="h-10 touch:h-11"
                            onClick={() => void act({ action: "unlink", id: task.id, path: file }, "Manual link removed")}>Unlink</Button>}
                          {!task && <Button size="sm" variant="outline" className="h-10 touch:h-11" disabled={!linkTarget || busy}
                            onClick={() => void act({ action: "link", id: linkTarget, path: file }, "File linked")}>Link</Button>}
                        </Card>
                      </li>;
                    })}
                  </ul>
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
              <GoalSelect label="Goal" value={field("goal_id")} onChange={(value) => change("goal_id", value)} options={goalOptions} />
            </div>}
            <label className="grid gap-1">Title
              {edit?.kind === "task" ? <Textarea required maxLength={800} rows={2} className="text-base sm:text-sm"
                value={field("title")} onChange={(event) => change("title", event.target.value.replace(/[\r\n]+/g, " "))} />
                : <Input required maxLength={800} className="h-11 text-base sm:h-9 sm:text-sm" value={field("title")} onChange={(event) => change("title", event.target.value)} />}
            </label>
            {edit?.kind === "task" && <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="grid min-w-0 gap-1"><span>State</span>
                  <GoalSelect label="State" value={edit.fields.decision ? "blocked" : field("state")} options={stateOptions}
                    disabled={!!edit.fields.decision} onChange={(value) => change("state", value)} />
                </div>
                <div className="grid min-w-0 gap-1"><span>Owner</span>
                  <GoalSelect label="Owner" value={field("owner")} onChange={(value) => change("owner", value)} options={withChoice("Unassigned", personOptions)} />
                </div>
                <div className="grid min-w-0 gap-1"><span>Priority</span>
                  <GoalSelect label="Priority" value={field("priority")} options={priorities} onChange={(value) => change("priority", value)} />
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
                .then((result) => { if (result) { if (goalRemoval) setGoalFilter(""); choose(""); setRemove(undefined); } });
            }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
