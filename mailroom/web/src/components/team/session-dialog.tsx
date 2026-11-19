"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Copy, Mail, SquareTerminal } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMailroom } from "@/components/mailroom/context";
import { api } from "@/lib/api";
import { effectiveState } from "@/lib/format";

const terminalStates = ["expired", "stopped", "finished", "failed"];

export function SessionDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { snap, refresh, setFolder, lastActivity, activityNow } = useMailroom();
  const agent = snap?.agents.find((entry) => entry.id === id);
  const admin = snap?.capabilities.admin;
  const stored = agent?.session_id ?? "";
  const cli = agent?.cli ? snap?.clis[agent.cli] : undefined;
  const [draft, setDraft] = useState(stored);
  const [baseId, setBaseId] = useState(stored);
  const [tab, setTab] = useState<"session" | "log">("session");
  const [log, setLog] = useState<string>();
  const [logError, setLogError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const resume = cli && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(stored)
    ? cli.resume.replace("{session}", stored) : null;
  const tailLive = agent?.kind === "temporary" && !terminalStates.includes(agent.state ?? "");

  useEffect(() => {
    if (tab !== "log") return;
    let active = true;
    const load = async () => {
      try {
        const result = await api.log(id);
        if (active) { setLog(result.log); setLogError(""); }
      } catch (error) {
        if (active) setLogError(String(error));
      }
    };
    void load();
    const timer = tailLive ? window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 4000) : undefined;
    return () => { active = false; window.clearInterval(timer); };
  }, [id, tab, tailLive]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const sessionId = draft.trim();
    setSaving(true);
    setSaveError("");
    try {
      await api.saveSessionId(id, sessionId, baseId);
      setBaseId(sessionId);
      await refresh();
      toast.success(sessionId ? "Session ID saved" : "Session ID cleared");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success("Copied"); }
    catch { toast.error("Select the text to copy it."); }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8"><SquareTerminal className="size-4 shrink-0" /> {id} · {agent?.name ?? "Session"}</DialogTitle>
          <DialogDescription>CLI session reference and Mailroom process output.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">Machine {agent?.machine ?? "A"}</Badge>
          {cli && <Badge variant="outline">{cli.label}</Badge>}
          <Badge variant="secondary">{agent?.kind === "temporary" ? "Temporary" : "Permanent"}</Badge>
          {agent && <Badge variant="outline">{effectiveState(agent, lastActivity.get(agent.id), activityNow)}</Badge>}
          <Button size="sm" variant="ghost" className="ml-auto h-10 touch:h-11" onClick={() => { onClose(); setFolder(`agent:${id}`); }}>
            <Mail /> Mail
          </Button>
        </div>
        <Tabs value={tab} onValueChange={(next) => setTab(next as "session" | "log")}>
          <TabsList aria-label="Session views" className="w-full">
            <TabsTrigger value="session" className="min-h-10 flex-1 touch:min-h-11">Session</TabsTrigger>
            <TabsTrigger value="log" className="min-h-10 flex-1 touch:min-h-11">Process log</TabsTrigger>
          </TabsList>
          <TabsContent value="session" className="space-y-3">
            <Card size="sm">
              <CardHeader><CardTitle>Conversation ID</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {admin ? <form className="space-y-2" onSubmit={save}>
                  <div className="flex flex-wrap gap-2">
                    <Input aria-label="CLI session ID" className="h-11 min-w-40 flex-1 font-mono text-base sm:h-9 sm:text-sm"
                      value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Paste the ID from the CLI" maxLength={160} />
                    <Button type="submit" size="sm" className="h-11 sm:h-9" disabled={saving || draft.trim() === stored}>Save</Button>
                  </div>
                  {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
                  {saveError && stored !== baseId && <Button type="button" size="sm" variant="outline" onClick={() => {
                    setDraft(stored); setBaseId(stored); setSaveError("");
                  }}>Load saved ID</Button>}
                </form> : <p className="break-all font-mono text-sm">{stored || "No recorded session ID."}</p>}
              </CardContent>
            </Card>
            {resume && <Card size="sm">
              <CardHeader><CardTitle>Resume on Machine {agent?.machine ?? "A"}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {agent?.workdir && <p className="break-all text-xs text-muted-foreground">{agent.workdir}</p>}
                <code className="block rounded-md bg-muted p-2 font-mono text-xs [overflow-wrap:anywhere]">{resume}</code>
                <Button size="sm" variant="outline" className="h-10 touch:h-11" onClick={() => void copy(resume)}><Copy /> Copy resume command</Button>
              </CardContent>
            </Card>}
          </TabsContent>
          <TabsContent value="log">
            {logError ? <p role="alert" className="text-sm text-destructive">{logError}</p>
              : log ? <pre className="max-h-[48dvh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{log}</pre>
                : <p className="py-3 text-muted-foreground">{log === undefined ? "Loading process log…" : "No Mailroom process output for this session."}</p>}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
