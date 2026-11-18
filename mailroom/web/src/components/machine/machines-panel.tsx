"use client";

import { CheckCircle2, CircleDashed, Laptop, Server, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import type { MachineInfo } from "@/lib/types";
import { AgentAvatar, CliIcon } from "@/components/mailroom/bits";
import { useMailroom } from "@/components/mailroom/context";

function Check({ ok, label, detail }: { ok: boolean | undefined; label: string; detail?: string }) {
  const Icon = ok === undefined ? CircleDashed : ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className={cn("mt-px size-3.5 shrink-0", ok === undefined ? "text-muted-foreground" : ok ? "text-emerald-600" : "text-red-500")} />
      <span>
        {label}
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </span>
    </div>
  );
}

/** Link health of a machine: whether its agents can reach the bus right now. */
export function machineLinkOk(m: MachineInfo | undefined): boolean | undefined {
  if (!m || m.kind === "local") return true;
  if (!m.checked_at) return undefined;
  return !!(m.reachable && m.tunnel_active !== false && m.bus_via_tunnel);
}

export function MachinesPanel() {
  const { snap } = useMailroom();
  const machines = snap?.machines ?? [];
  const agents = (snap?.agents ?? []).filter((a) => !a.id.includes(".") && !a.retired);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {machines.map((m) => {
        const ok = machineLinkOk(m);
        const here = agents.filter((a) => (a.machine ?? "A") === m.id && !(a.kind === "temporary" && ["expired", "stopped", "finished", "failed"].includes(a.state ?? "")));
        return (
          <div key={m.id} className={cn("rounded-xl border bg-card p-4", ok === false && "border-red-300 dark:border-red-900")}>
            <div className="flex items-start gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/15 text-sky-500">{m.kind === "local" ? <Laptop className="size-5" /> : <Server className="size-5" />}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{m.label}</span>
                  {m.wsl && <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium">WSL2</span>}
                  <span
                    className={cn(
                      "ml-auto rounded-full px-2 py-0.5 text-xs font-medium",
                      ok === undefined ? "bg-muted text-muted-foreground" : ok ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
                    )}
                  >
                    {m.kind === "local" ? "local" : ok === undefined ? "probing…" : ok ? "connected" : "link down"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{m.note}</p>
              </div>
            </div>
            <div className="mt-3 space-y-1.5">
              {m.kind === "ssh" ? (
                <>
                  <Check ok={m.tunnel_active} label={`Reverse tunnel ${m.tunnel_unit ?? ""}`} detail={m.tunnel_active ? "active on machine A" : "inactive"} />
                  <Check ok={m.reachable} label="SSH from machine A" detail={m.reachable ? `${m.latency_ms} ms` : m.error} />
                  <Check ok={m.bus_via_tunnel} label="Bus reachable from this machine" detail="127.0.0.1:8766 through the tunnel" />
                  <Check ok={m.repo_found} label={`Repository ~/${m.repo ?? ""}`} />
                </>
              ) : (
                <Check ok label="Runs the bus server and the mailroom" />
              )}
              <Check
                ok={m.mem_avail_gib === undefined ? undefined : m.mem_avail_gib >= 6}
                label="Memory"
                detail={m.mem_total_gib ? `${m.mem_avail_gib} GiB free of ${m.mem_total_gib}` : "unknown"}
              />
              <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
                <span className="text-muted-foreground">Agent CLIs:</span>
                {m.clis.length ? (
                  m.clis.map((c) => (
                    <span key={c} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
                      <CliIcon cli={c} /> {c}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">none installed{m.kind === "ssh" ? " (agents here run outside this shell, e.g. on Windows, and use the bus over HTTP)" : ""}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">Agents:</span>
                {here.length ? here.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-1">
                    <AgentAvatar id={a.id} agent={a} size="sm" showState /> {a.id}
                  </span>
                )) : <span className="text-muted-foreground">none</span>}
              </div>
              {m.checked_at && m.kind === "ssh" && <p className="pt-1 text-[11px] text-muted-foreground">Probed {ago(m.checked_at)} (every 60 s)</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
