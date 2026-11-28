"use client";

import { useEffect, useId, useRef } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { needsPreview } from "@/lib/resolve-human";
import { eventTaskId } from "@/lib/threads";
import type { BusEvent } from "@/lib/types";
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
  onConfirm: () => Promise<boolean>;
}) {
  const { taskTags } = useMailroom();
  const plural = targets.length > 1;
  const first = targets[0];
  const firstTag = eventTaskId(first, taskTags);
  const summaryLine = plural
    ? targets.map((e) => e.id).join(", ")
    : `${first.id}${firstTag ? ` · ${firstTag}` : ""} — ${needsPreview(first, 90)}`;

  return (
    <>
      <div className="space-y-1.5">
        <h1 id={titleId} className="font-heading text-base leading-snug font-semibold">
          {plural
            ? `Are you sure you answered these ${targets.length} items or want them marked resolved?`
            : "Are you sure you answered this or want it marked resolved?"}
        </h1>
        <p id={descId} className="truncate text-xs text-muted-foreground" title={summaryLine}>
          {summaryLine}
        </p>
      </div>

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
          onClick={() => void onConfirm()}
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
