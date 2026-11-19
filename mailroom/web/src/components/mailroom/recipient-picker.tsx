"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { effectiveState } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { AgentAvatar, CliIcon, Tip } from "./bits";
import { useMailroom } from "./context";

const ENDED = ["expired", "stopped", "finished", "failed"];

export function useAddressable() {
  const { snap } = useMailroom();
  return (snap?.agents ?? []).filter(
    (a) => !a.id.includes(".") && !a.retired && !(a.kind === "temporary" && ENDED.includes(a.state ?? "")),
  );
}

export function RecipientPicker({
  label,
  value,
  onChange,
  multiple,
  exclude = [],
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  exclude?: string[];
}) {
  const { agents, lastActivity } = useMailroom();
  const options = useAddressable().filter((a) => !exclude.includes(a.id));
  const [open, setOpen] = useState(false);

  const toggle = (id: string) => {
    if (!multiple) {
      onChange([id]);
      setOpen(false);
      return;
    }
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <div className="flex min-h-9 items-center gap-2 border-b px-1 py-1">
      <span className="w-8 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {value.map((id) => {
          const a = agents.get(id);
          const gone = !options.some((o) => o.id === id) && !exclude.includes(id);
          return (
            <Tip key={id} label={gone ? "Retired or ended — the bus will refuse this message" : id} side="bottom">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border bg-accent/60 py-0.5 pr-1 pl-0.5 text-xs",
                  gone && "border-destructive/50 bg-destructive/10 text-destructive",
                )}
              >
                <AgentAvatar id={id} size="sm" />
                <span className="font-medium">{id}</span>
                {a?.name && a.name !== id && <span className="text-muted-foreground">{a.name}</span>}
                <button type="button" aria-label={`Remove ${id}`} onClick={() => onChange(value.filter((v) => v !== id))} className="rounded-full p-0.5 hover:bg-muted">
                  <X className="size-3" />
                </button>
              </span>
            </Tip>
          );
        })}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            }
          >
            <Plus className="size-3.5" /> {value.length && !multiple ? "Change" : "Add"}
          </PopoverTrigger>
          <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] max-h-(--available-height) overflow-hidden p-0" align="start">
            <Command>
              <CommandInput placeholder="Find an agent…" />
              <CommandList>
                <CommandEmpty>No agent found.</CommandEmpty>
                <CommandGroup>
                  {options.map((a) => (
                    <CommandItem key={a.id} value={`${a.id} ${a.name} ${a.role ?? ""}`} onSelect={() => toggle(a.id)} data-checked={value.includes(a.id)}>
                      <AgentAvatar id={a.id} agent={a} size="sm" showState />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm">
                          <span className="font-medium">{a.id}</span>
                          <span className="truncate text-muted-foreground">{a.name}</span>
                          <CliIcon cli={a.cli} className="text-muted-foreground" />
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {a.kind === "temporary" ? "temporary · " : ""}
                          {a.role} · {effectiveState(a, lastActivity.get(a.id))}
                        </div>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
