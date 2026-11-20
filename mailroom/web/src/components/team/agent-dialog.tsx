"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { applyRoleLabelChange, applyRolePresetSelection, buildAgentUpsertPayload } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { useMailroom } from "@/components/mailroom/context";

const EMPTY: Partial<Agent> = { id: "", name: "", role: "worker", role_preset: "worker", role_prompt: "", machine: "A", cli: "claude", session_id: "", workdir: "", notes: "" };

export function AgentDialog({ open, onOpenChange, agent }: { open: boolean; onOpenChange: (v: boolean) => void; agent: Agent | null }) {
  const { snap, refresh } = useMailroom();
  const [form, setForm] = useState<Partial<Agent>>(EMPTY);
  const [busy, setBusy] = useState(false);
  const wasOpen = useRef(false);
  const isNew = !agent;
  const clis = snap?.clis ?? {};
  const roles = snap?.roles ?? {};
  const cliItems = Object.entries(clis).map(([value, { label }]) => ({ value, label: `${label} (${value})` }));

  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(agent ? { ...EMPTY, ...agent } : { ...EMPTY, id: nextId(snap?.agents ?? []) });
    }
    wasOpen.current = open;
  }, [open, agent, snap?.agents]);

  const set = (k: keyof Agent) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.upsertAgent(buildAgentUpsertPayload(form, roles));
      await refresh({ full: true });
      toast.success(isNew ? `Registered ${form.id}` : `Saved ${form.id}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Not saved: ${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const resume = form.cli && form.session_id ? clis[form.cli]?.resume.replace("{session}", form.session_id) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "Register an agent" : `Edit ${agent?.id}`}</DialogTitle>
          <DialogDescription>
            Permanent team members. The session id is the CLI conversation to resume (it is shown with the resume command); routes are set in &ldquo;Who talks to whom&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Bus id</Label>
            <Input value={form.id ?? ""} onChange={set("id")} disabled={!isNew} className="font-mono" placeholder="a6" />
          </div>
          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input value={form.name ?? ""} onChange={set("name")} placeholder="Claude Code" />
          </div>
          <div className="space-y-1.5">
            <Label>CLI</Label>
            <SearchableSelect label="CLI" value={form.cli ?? null} options={cliItems}
              onChange={(cli) => setForm((current) => ({ ...current, cli }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Role label</Label>
            <Input
              value={form.role ?? ""}
              onChange={(e) => setForm((f) => applyRoleLabelChange(f, e.target.value, roles))}
              placeholder="orchestrator, reviewer, worker…"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Role prompt</Label>
            <div className="flex flex-wrap gap-1">
              {Object.entries(roles).map(([k, r]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setForm((f) => applyRolePresetSelection(f, k, roles))}
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs", form.role_preset === k ? "tool-active border-transparent" : "hover:bg-muted")}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Textarea
              value={form.role_prompt || (form.role_preset ? roles[form.role_preset]?.prompt ?? "" : "")}
              onChange={set("role_prompt")}
              rows={4}
              className="text-xs"
              placeholder="What this agent is responsible for and how it should behave. Included in its Connect prompt."
            />
          </div>
          <div className="space-y-1.5">
            <Label>Machine</Label>
            <Input value={form.machine ?? ""} onChange={set("machine")} placeholder="A" />
          </div>
          <div className="space-y-1.5">
            <Label>Session / conversation id</Label>
            <Input value={form.session_id ?? ""} onChange={set("session_id")} className="font-mono text-xs" placeholder="optional" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Working directory</Label>
            <Input value={form.workdir ?? ""} onChange={set("workdir")} className="font-mono text-xs" placeholder="optional, e.g. a worktree path" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Notes</Label>
            <Textarea value={form.notes ?? ""} onChange={set("notes")} rows={2} />
          </div>
          {resume && (
            <div className="rounded-md bg-muted p-2 font-mono text-xs sm:col-span-2">
              <span className="font-sans text-muted-foreground">Resume: </span>
              {resume}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !form.id}>
            {busy && <Loader2 className="animate-spin" />} {isNew ? "Register" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function nextId(agents: Agent[]): string {
  let n = 0;
  for (const a of agents) {
    const m = a.id.match(/^a(\d+)$/);
    if (m) n = Math.max(n, +m[1]);
  }
  return `a${n + 1}`;
}
