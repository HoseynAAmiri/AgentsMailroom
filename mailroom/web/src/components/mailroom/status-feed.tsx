"use client";

import { useMemo, useState } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago, fullTime } from "@/lib/format";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { AgentAvatar, RichText, StateDot } from "./bits";
import { useMailroom } from "./context";
import { STATUS_HEADER_CLS } from "./page-skeletons";

export function StatusFeed() {
  const { events, agents, search, setNavOpen } = useMailroom();
  const [who, setWho] = useState<string>("all");
  const [limit, setLimit] = useState(80);
  const all = useMemo(() => events.filter((e) => e.type === "agent.status").reverse(), [events]);
  const senders = useMemo(() => [...new Set(all.map((e) => e.from))].sort(), [all]);
  const q = search.trim().toLowerCase();
  const list = all.filter((e) => (who === "all" || e.from === who) && (!q || e.body.toLowerCase().includes(q) || e.from.includes(q)));

  return (
    <div className="flex h-full flex-col">
      <div className={STATUS_HEADER_CLS}>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Folders" className="-ml-1 lg:hidden" onClick={() => setNavOpen(true)}>
            <Menu />
          </Button>
          <h2 className="text-base font-semibold">Status feed</h2>
        </div>
        <p className="text-xs text-muted-foreground">Agent heartbeats, broadcast to everyone — not delivered to inboxes.</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {["all", ...senders].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setWho(s)}
              className={cn("rounded-full border px-2.5 py-0.5 text-xs", who === s ? "tool-active border-transparent" : "hover:bg-muted")}
            >
              {s === "all" ? "Everyone" : s}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="relative mx-auto max-w-4xl p-3 sm:p-4">
          {list.slice(0, limit).map((e) => (
            <li key={e.id} className="relative flex gap-3 pb-4 pl-1">
              <AgentAvatar id={e.from} size="sm" />
              <div className="min-w-0 flex-1 rounded-lg border bg-card px-3 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold">{agents.get(e.from)?.name ?? e.from}</span>
                  <span className="text-muted-foreground">{e.from}</span>
                  {e.state && (
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      <StateDot state={e.state} /> {e.state}
                    </span>
                  )}
                  {e.task_id && <span className="font-mono text-muted-foreground">{e.task_id}</span>}
                  <span className="ml-auto text-muted-foreground" title={fullTime(e.ts)}>
                    {ago(e.ts)} · {e.id}
                  </span>
                </div>
                <RichText text={e.body} className="mt-1 text-[13px]" />
              </div>
            </li>
          ))}
        </ol>
        {list.length > limit && (
          <div className="pb-6 text-center">
            <Button variant="ghost" onClick={() => setLimit(limit + 80)}>
              Show {Math.min(80, list.length - limit)} more of {list.length - limit}
            </Button>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
