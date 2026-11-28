"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { RESOLUTION_PRESETS } from "@/lib/format";
import { toggleResolutionPreset } from "@/lib/resolve-human";
import { eventTaskId, snippet } from "@/lib/threads";
import type { BusEvent, ResolutionChannel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { useMailroom } from "./context";

function ResolveDialogForm({
  targets,
  titleId,
  descId,
  resolving,
  onCancel,
  onConfirm,
}: {
  targets: BusEvent[];
  titleId: string;
  descId: string;
  resolving: boolean;
  onCancel: () => void;
  onConfirm: (via: ResolutionChannel | null) => Promise<boolean>;
}) {
  const { agents, taskTags } = useMailroom();
  const [via, setVia] = useState<ResolutionChannel | null>(null);
  const plural = targets.length > 1;

  return (
    <>
      <div className="space-y-1.5">
        <h1 id={titleId} className="font-heading text-base leading-snug font-semibold">
          {plural ? `Mark ${targets.length} needs-you items as resolved?` : "Mark needs-you item as resolved?"}
        </h1>
        <p id={descId} className="text-sm text-muted-foreground">
          Use this when you already answered outside Mailroom. No message text is sent.
        </p>
      </div>

      <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg border bg-muted/40 p-2.5 text-xs">
        {targets.map((e) => {
          const tag = eventTaskId(e, taskTags);
          const sender = agents.get(e.from)?.name ?? e.from;
          return (
            <div key={e.id} className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                <span className="font-semibold text-foreground">{e.id}</span>
                {tag && <span>· {tag}</span>}
                <span>· from {sender}</span>
              </div>
              <p className="line-clamp-2 font-sans text-foreground/90">
                {e.subject || snippet(e.body, 140)}
              </p>
            </div>
          );
        })}
      </div>

      <fieldset className="space-y-2" disabled={resolving}>
        <legend className="text-xs font-medium text-muted-foreground">
          Where did you answer? (optional)
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {RESOLUTION_PRESETS.map((preset) => {
            const active = via === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                aria-pressed={active}
                data-resolution-preset={preset.value}
                onClick={() => setVia((cur) => toggleResolutionPreset(cur, preset.value))}
                className={cn(
                  "inline-flex min-h-8 items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors touch:min-h-10",
                  active
                    ? "tool-active border-transparent"
                    : "bg-background text-foreground/85 hover:bg-muted hover:text-foreground",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          autoFocus
          disabled={resolving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={resolving}
          data-confirm-resolve="true"
          onClick={() => void onConfirm(via)}
        >
          {resolving ? <Loader2 className="animate-spin" aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
          Mark resolved
        </Button>
      </div>
    </>
  );
}

export function ResolveHumanDialog() {
  const { resolveTarget, cancelResolve, confirmResolve, resolving } = useMailroom();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const pressedOutsideRef = useRef(false);
  const open = !!resolveTarget && resolveTarget.length > 0;
  const targetKey = resolveTarget?.map((e) => e.id).join(",") ?? "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-resolve-human-dialog="true"
      className="mr-resolve-dialog fixed top-1/2 left-1/2 z-50 m-0 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border-0 bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
      onCancel={(e) => {
        if (resolving) e.preventDefault();
      }}
      onClose={(e) => {
        e.currentTarget.returnValue = "";
        cancelResolve();
      }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        pressedOutsideRef.current =
          e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
      }}
      onPointerUp={(e) => {
        if (resolving || !pressedOutsideRef.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const releasedOutside =
          e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
        pressedOutsideRef.current = false;
        if (releasedOutside) e.currentTarget.close();
      }}
    >
      {resolveTarget && resolveTarget.length > 0 ? (
        <ResolveDialogForm
          key={targetKey}
          targets={resolveTarget}
          titleId={titleId}
          descId={descId}
          resolving={resolving}
          onCancel={() => dialogRef.current?.close()}
          onConfirm={confirmResolve}
        />
      ) : null}
    </dialog>
  );
}
