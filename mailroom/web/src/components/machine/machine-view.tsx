"use client";

import { Box, Cpu, MemoryStick } from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMailroom } from "@/components/mailroom/context";
import { Tip } from "@/components/mailroom/bits";
import { MachinesPanel } from "./machines-panel";

export function memLevel(avail: number): "ok" | "warn" | "bad" {
  return avail < 6 ? "bad" : avail < 10 ? "warn" : "ok";
}

export function MachineView() {
  const { snap } = useMailroom();
  const mem = snap?.memory && "total_gib" in snap.memory ? snap.memory : null;
  const runs = snap?.runs ?? [];
  const procs = snap?.processes ?? [];
  const temps = (snap?.agents ?? []).filter((a) => a.kind === "temporary" && !["expired", "stopped", "finished", "failed"].includes(a.state ?? ""));

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-8 p-3 pb-8 sm:p-6">
        <MachinesPanel />
        {mem && (
          <section className="rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <MemoryStick className="size-4 text-sky-500" />
              <h2 className="text-base font-semibold">Machine A memory</h2>
              <span
                className={cn(
                  "ml-auto text-sm font-medium",
                  memLevel(mem.avail_gib) === "bad" ? "text-destructive" : memLevel(mem.avail_gib) === "warn" ? "text-amber-600" : "text-emerald-600",
                )}
              >
                {mem.avail_gib} GiB available of {mem.total_gib}
              </span>
            </div>
            <Progress className="mt-3" value={((mem.total_gib - mem.avail_gib) / mem.total_gib) * 100} />
            <p className="mt-2 text-xs text-muted-foreground">
              Keep at least 6 GiB free after any launch. Swap in use: {mem.swap_used_gib} GiB.
            </p>
          </section>
        )}

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Box className="size-4 text-sky-500" /> Solver containers <span className="text-sm font-normal text-muted-foreground">({runs.length})</span>
          </h2>
          {runs.length ? (
            <div className="divide-y rounded-lg border">
              {runs.map((r) => (
                <div key={r.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                  <span className="min-w-0 truncate font-mono font-medium">{r.name}</span>
                  <span className="text-muted-foreground">{r.status}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {r.cpu && `CPU ${r.cpu}`} {r.mem && `· ${r.mem}`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No solver container running on machine A.</p>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Cpu className="size-4 text-sky-500" /> Agent processes <span className="text-sm font-normal text-muted-foreground">({procs.length + temps.length})</span>
          </h2>
          <div className="divide-y rounded-lg border">
            {procs.map((p) => (
              <details key={p.pid} className="px-4 py-2.5 text-sm">
                <summary className="cursor-pointer">
                  <span className="font-semibold">{p.agent}</span> <span className="text-muted-foreground">pid {p.pid}</span> · {p.rss_gib} GiB · {p.cpu_pct}% CPU · up{" "}
                  {(p.uptime_s / 3600).toFixed(1)} h · {p.n_children} children
                </summary>
                <div className="mt-2 space-y-0.5 pl-4">
                  {p.children.map((c) => (
                    <Tip key={c.pid} label={c.cmd} side="right" className="min-w-0">
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {c.rss_mib} MiB · {c.cmd}
                      </div>
                    </Tip>
                  ))}
                </div>
              </details>
            ))}
            {temps.map((a) => (
              <div key={a.id} className="px-4 py-2.5 text-sm">
                <span className="font-semibold">{a.id}</span> <span className="break-all text-muted-foreground">temporary · {a.cli} · unit {a.unit}</span>
                {a.mem_peak_bytes ? ` · peak ${(a.mem_peak_bytes / 1073741824).toFixed(2)} GiB` : ""}
              </div>
            ))}
            {!procs.length && !temps.length && <p className="p-4 text-sm text-muted-foreground">No agent processes matched.</p>}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}
