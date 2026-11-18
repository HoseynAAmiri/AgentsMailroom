"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, ShieldCheck, ShieldAlert, Timer } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AgentAvatar, CliIcon } from "@/components/mailroom/bits";
import { useMailroom } from "@/components/mailroom/context";
import { RecipientPicker } from "@/components/mailroom/recipient-picker";

const DURATIONS = [15, 30, 60, 120, 240];
const CLI_ORDER = ["claude", "codex", "cursor-agent", "opencode", "agy"];
const ENDED = ["expired", "stopped", "finished", "failed"];

export function SummonDialog() {
  const { snap, summonOpen, setSummonOpen, refresh, setView, setFolder, select } = useMailroom();
  // Back is registered in MailroomProvider (closes this dialog).
  const clis = snap?.clis ?? {};
  const limits = snap?.limits;
  const [cli, setCli] = useState("claude");
  const [machineId, setMachineId] = useState("A");
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState(30);
  const [access, setAccess] = useState<"standard" | "full">("standard");
  const [model, setModel] = useState("");
  const [peers, setPeers] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [taskId, setTaskId] = useState("");
  const [brief, setBrief] = useState("");
  const [rolePreset, setRolePreset] = useState("researcher");
  const [rolePrompt, setRolePrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (summonOpen && !name) setName(`${clis[cli]?.label ?? cli} helper`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summonOpen]);

  const team = (snap?.agents ?? []).filter((a) => (a.kind ?? "permanent") === "permanent" && !a.retired && !a.id.includes("."));
  const activeTemps = (snap?.agents ?? []).filter((a) => a.kind === "temporary" && !ENDED.includes(a.state ?? "")).length;
  const machine = snap?.machines?.find((m) => m.id === machineId);
  const mem = machine?.mem_avail_gib != null ? { avail_gib: machine.mem_avail_gib } : null;
  const cliOn = (k: string) => (machine ? machine.clis.includes(k) : !!clis[k]?.available);
  const remoteBlocked = machine?.kind === "ssh" && !(machine.reachable && machine.bus_via_tunnel);
  const memAfter = mem && limits ? mem.avail_gib - limits.summon_est_gib : null;
  const memOk = memAfter == null || !limits || memAfter >= limits.min_avail_after_gib;
  const slotsOk = !limits || activeTemps < limits.max_active_temp;
  const admin = !!snap?.capabilities.admin;
  const modelFormatOk = cli !== "opencode" || !model.trim() || /^[^/\s]+\/\S+$/.test(model.trim());

  const preview = useMemo(() => {
    const tmpl = clis[cli]?.[access] ?? [];
    const parts = tmpl.map((p) =>
      p
        .replace("{prompt}", "<prompt>")
        .replace("{repo}", "<repo>")
        .replace("{ttl_s}", String(ttl * 60))
        .replace("{bus_py}", "<bus.py>"),
    );
    if (model.trim()) parts.push(cli === "codex" || cli === "opencode" ? "-m" : "--model", model.trim());
    if (machine?.kind === "ssh") return `systemd-run --user RuntimeMaxSec=${ttl * 60} -- ssh -tt <${machine.label} via ${machine.tunnel_unit}> "cd ~/${machine.repo} && timeout ${ttl * 60}s ${parts.join(" ")}"`;
    return `systemd-run --user RuntimeMaxSec=${ttl * 60} MemoryMax=${limits?.memory_max_gib ?? 6}G -- ${parts.join(" ")}`;
  }, [clis, cli, access, ttl, model, limits, machine]);

  const submit = async () => {
    if (!brief.trim()) {
      toast.error("Write the brief: it becomes the first message in the agent's inbox");
      return;
    }
    setBusy(true);
    try {
      const out = await api.summon({ cli, machine: machineId, name, role_preset: rolePreset, role_prompt: rolePrompt.trim() || undefined, ttl_min: ttl, access, model: model.trim() || undefined, peers, cc, subject, task_id: taskId, brief });
      toast(`Launch requested for ${out.agent.id} (${clis[cli]?.label})`, { description: `Brief ${out.brief.id} is in its inbox. Check Temporary agents for process status.` });
      setSummonOpen(false);
      setBrief("");
      setSubject("");
      setTaskId("");
      setName("");
      await refresh();
      setView("mail");
      setFolder(`agent:${out.agent.id}`);
      select(out.brief.task_id ? `task:${out.brief.task_id}` : `ev:${out.brief.id}`, { markRead: false });
    } catch (err) {
      toast.error(`Summon failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={summonOpen} onOpenChange={setSummonOpen}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Timer className="size-5 text-sky-500" /> Summon a temporary agent
          </DialogTitle>
          <DialogDescription>
            Starts a timed CLI agent as its own systemd unit. It gets a bus id (t1, t2, …), reads your brief from its inbox, and stops when its time ends.
          </DialogDescription>
        </DialogHeader>

        {!admin && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              This port is shared with machine B, so it cannot start processes. Open the local command center at{" "}
              <a className="font-medium underline" href={snap?.capabilities.admin_url ?? "#"}>
                {snap?.capabilities.admin_url}
              </a>
              .
            </span>
          </div>
        )}

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Machine</Label>
            <div className="flex flex-wrap gap-2">
              {(snap?.machines ?? []).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setMachineId(m.id);
                    if (!m.clis.includes(cli) && m.clis[0]) setCli(m.clis[0]);
                  }}
                  className={cn("rounded-lg border px-3 py-2 text-left text-sm", machineId === m.id ? "tool-active border-transparent" : "hover:bg-muted")}
                >
                  <span className="font-medium">{m.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {m.kind === "local" ? "local" : m.reachable ? `SSH ok · ${m.clis.length} CLI${m.clis.length === 1 ? "" : "s"}` : "unreachable"}
                    {m.mem_avail_gib != null ? ` · ${m.mem_avail_gib} GiB free` : ""}
                  </span>
                </button>
              ))}
            </div>
            {machine?.kind === "ssh" && machine.clis.length === 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                No agent CLI is installed inside {machine.label}&apos;s {machine.wsl ? "WSL2 " : ""}shell, so nothing can be summoned there yet. Install one (e.g. claude or codex) in that shell and it appears here within a minute.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>CLI</Label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {CLI_ORDER.filter((k) => clis[k]).map((k) => (
                <button
                  key={k}
                  type="button"
                  disabled={!cliOn(k)}
                  onClick={() => {
                    setCli(k);
                    setName(`${clis[k].label} helper`);
                  }}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-xs transition-colors disabled:opacity-40",
                    cli === k ? "tool-active border-transparent" : "hover:bg-muted",
                  )}
                >
                  <CliIcon cli={k} className="size-5" />
                  <span className="font-medium">{clis[k].label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Display name</Label>
              <Input id="s-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-model">Model (optional)</Label>
              <Input id="s-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={cli === "opencode" ? "opencode/glm-5.3-flash-free" : "CLI default"} aria-invalid={!modelFormatOk} />
              {!modelFormatOk && <p className="text-xs text-destructive">Use the full OpenCode model ID in provider/model format.</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Role</Label>
            <div className="flex flex-wrap gap-1">
              {Object.entries(snap?.roles ?? {}).map(([k, r]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setRolePreset(k);
                    setRolePrompt("");
                  }}
                  className={cn("rounded-full border px-3 py-1 text-sm", rolePreset === k ? "tool-active border-transparent" : "hover:bg-muted")}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Textarea
              value={rolePrompt || snap?.roles?.[rolePreset]?.prompt || ""}
              onChange={(e) => setRolePrompt(e.target.value)}
              rows={3}
              className="text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label>Time limit</Label>
            <div className="flex flex-wrap items-center gap-2">
              {DURATIONS.filter((d) => !limits || d <= limits.max_ttl_min).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setTtl(d)}
                  className={cn("rounded-full border px-3 py-1 text-sm", ttl === d ? "tool-active border-transparent" : "hover:bg-muted")}
                >
                  {d < 60 ? `${d} min` : `${d / 60} h`}
                </button>
              ))}
              <Input
                type="number"
                min={1}
                max={limits?.max_ttl_min ?? 300}
                value={ttl}
                onChange={(e) => setTtl(Math.max(1, Math.min(limits?.max_ttl_min ?? 300, Number(e.target.value) || 1)))}
                className="h-8 w-20"
              />
              <span className="text-sm text-muted-foreground">minutes</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Permissions</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setAccess("standard")}
                className={cn("flex gap-2 rounded-lg border p-3 text-left text-sm", access === "standard" ? "tool-active border-transparent" : "hover:bg-muted")}
              >
                <ShieldCheck className="size-5 shrink-0 text-emerald-600" />
                <span>
                  <span className="font-medium">Standard</span>
                  <span className="block text-xs text-muted-foreground">The CLI&apos;s normal non-interactive permissions, plus bus commands.</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAccess("full")}
                className={cn("flex gap-2 rounded-lg border p-3 text-left text-sm", access === "full" ? "border-destructive bg-destructive/5 ring-1 ring-destructive" : "hover:bg-muted")}
              >
                <ShieldAlert className="size-5 shrink-0 text-destructive" />
                <span>
                  <span className="font-medium">Full auto</span>
                  <span className="block text-xs text-muted-foreground">Skips approval prompts (shell, edits). For work you would let it run unattended.</span>
                </span>
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>May also message</Label>
            <div className="flex flex-wrap gap-3">
              {team.map((a) => (
                <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={peers.includes(a.id)} onCheckedChange={(v) => setPeers((p) => (v ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
                  <AgentAvatar id={a.id} size="sm" />
                  {a.id} <span className="text-muted-foreground">{a.name}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">You are always included. Temporary routes, removed when the agent ends.</p>
          </div>

          <div className="space-y-1.5 rounded-lg border p-3">
            <Label>Brief (first message in its inbox)</Label>
            <RecipientPicker label="Cc" value={cc} onChange={setCc} multiple />
            <div className="flex flex-col gap-2 pt-1 sm:flex-row">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
              <Input value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="Task id (optional)" className="w-full font-mono text-xs sm:w-44" />
            </div>
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={6} placeholder="What should it do, what should it report, and what is out of bounds?" />
          </div>

          <div className="space-y-1.5">
            <Label>Command</Label>
            <pre className="overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{preview}</pre>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className={cn(memOk ? "text-muted-foreground" : "font-medium text-destructive")}>
                Memory: {mem ? `${mem.avail_gib} GiB free` : "unknown"}
                {memAfter != null && ` → about ${memAfter.toFixed(1)} GiB after launch (estimate ${limits?.summon_est_gib} GiB; floor ${limits?.min_avail_after_gib} GiB)`}
              </span>
              <span className={cn(slotsOk ? "text-muted-foreground" : "font-medium text-destructive")}>
                Active temporary agents: {activeTemps} / {limits?.max_active_temp ?? "?"}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setSummonOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !admin || !memOk || !slotsOk || !cliOn(cli) || remoteBlocked || !modelFormatOk}>
            {busy ? <Loader2 className="animate-spin" /> : <Timer />} Summon for {ttl < 60 ? `${ttl} min` : `${+(ttl / 60).toFixed(2)} h`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
