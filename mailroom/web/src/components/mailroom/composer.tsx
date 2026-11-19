"use client";

import { useEffect, useRef, useState } from "react";
import { Forward, ImagePlus, Loader2, Reply, ReplyAll, Send, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RecipientPicker } from "./recipient-picker";
import { RefChip } from "./bits";
import { useMailroom } from "./context";

const MODE_LABEL = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward" } as const;
const MODE_ICON = { new: Send, reply: Reply, replyAll: ReplyAll, forward: Forward } as const;

export function Composer({ inline }: { inline?: boolean }) {
  const { compose, updateCompose, discardCompose, saveDraft, send, sending } = useMailroom();
  const [confirmClose, setConfirmClose] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [taskChoices, setTaskChoices] = useState<{ id: string; title: string }[]>();
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = compose?.mode;

  useEffect(() => {
    if (!mode) return;
    rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const ta = bodyRef.current;
    if (ta) {
      ta.focus({ preventScroll: true });
      if (mode === "forward") ta.setSelectionRange(0, 0);
    }
  }, [mode, compose?.inReplyTo]);

  if (!compose) return null;

  const attach = async (files: Iterable<File>) => {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setUploading(true);
    try {
      for (const f of imgs) {
        const out = await api.uploadAttachment(f, f.name || "image.png");
        const ref = { kind: "file", value: `coordination/attachments/${out.name}` };
        if (!compose.refs.some((r) => r.kind === ref.kind && r.value === ref.value)) updateCompose({ refs: [...compose.refs, ref] });
      }
      toast.success(`${imgs.length} image${imgs.length === 1 ? "" : "s"} attached`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const Icon = MODE_ICON[compose.mode];

  return (
    <div
      ref={rootRef}
      className={cn("flex flex-col rounded-lg border bg-card shadow-sm", inline ? "mt-4" : "h-full rounded-none border-0 shadow-none")}
      onKeyDown={(e) => {
        if (sending || confirmClose) return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void send();
        }
        if (e.key === "Escape" && !e.defaultPrevented) setConfirmClose(true);
      }}
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon className="size-4 text-sky-500" />
        <span className="text-sm font-semibold">{MODE_LABEL[compose.mode]}</span>
        {compose.inReplyTo && <span className="text-xs text-muted-foreground">to {compose.inReplyTo}</span>}
        <Button variant="ghost" size="icon-sm" aria-label="Close composer" className="ml-auto" disabled={sending} onClick={() => setConfirmClose(true)}>
          <X />
        </Button>
      </div>
      <div className="px-3">
        <RecipientPicker label="To" value={compose.to ? [compose.to] : []} onChange={(v) => updateCompose({ to: v[v.length - 1] ?? "" })} />
        <RecipientPicker label="Cc" value={compose.cc} onChange={(v) => updateCompose({ cc: v })} multiple exclude={compose.to ? [compose.to] : []} />
        <div className="flex items-center gap-2 border-b py-1">
          <Input
            value={compose.subject}
            onChange={(e) => updateCompose({ subject: e.target.value })}
            placeholder="Subject"
            className="h-8 flex-1 border-0 px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <Input
            value={compose.taskId}
            onChange={(e) => updateCompose({ taskId: e.target.value })}
            aria-label="Task ID"
            placeholder="Task ID"
            className="h-7 w-28 font-mono text-xs sm:w-44"
            title="Choose a project task or enter an existing conversation ID"
          />
          <Popover open={taskPickerOpen} onOpenChange={(open) => {
            setTaskPickerOpen(open);
            if (open && !taskChoices) void api.goalChoices().then((data) => setTaskChoices(data.tasks)).catch(() => setTaskChoices([]));
          }}>
            <PopoverTrigger render={<Button size="icon-sm" variant="ghost" className="shrink-0 touch:size-11" aria-label="Choose a task"><Tag /></Button>} />
            <PopoverContent align="end" className="w-[min(23rem,calc(100vw-1.5rem))] max-h-(--available-height) overflow-hidden p-0">
              <Command>
                <CommandInput placeholder="Find a task…" />
                <CommandList>
                  <CommandEmpty>{taskChoices ? "No tasks match." : "Loading tasks…"}</CommandEmpty>
                  {taskChoices?.map((task) => (
                    <CommandItem key={task.id} value={`${task.id} ${task.title}`} className="min-h-11"
                      onSelect={() => { updateCompose({ taskId: task.id }); setTaskPickerOpen(false); }}>
                      <Badge variant="outline" className="font-mono">{task.id}</Badge>
                      <span className="min-w-0 truncate">{task.title}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <Textarea
        ref={bodyRef}
        value={compose.body}
        onChange={(e) => updateCompose({ body: e.target.value })}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            void attach(e.clipboardData.files);
          }
        }}
        placeholder="Write your message…  (paste or attach images)"
        className={cn(
          "resize-none rounded-none border-0 px-4 py-3 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent",
          inline ? "min-h-40" : "min-h-0 flex-1",
        )}
      />
      {compose.refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {compose.refs.map((r) => (
            <RefChip key={`${r.kind}:${r.value}`} r={r} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void attach(e.target.files ?? [])}
        />
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Attach image" disabled={uploading || sending} onClick={() => fileRef.current?.click()} />}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
          </TooltipTrigger>
          <TooltipContent>Attach image (or paste into the text)</TooltipContent>
        </Tooltip>
        <span className="hidden text-xs text-muted-foreground sm:inline">{compose.body.length} chars · draft saved</span>
        <Tooltip>
          <TooltipTrigger
            render={<Button className="ml-auto" aria-label="Send" disabled={sending} onClick={() => void send()} />}
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
          </TooltipTrigger>
          <TooltipContent>Ctrl+Enter to send · sent as USER</TooltipContent>
        </Tooltip>
      </div>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this message?</AlertDialogTitle>
            <AlertDialogDescription>Save the draft to finish it later, or discard it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel size="sm">Keep writing</AlertDialogCancel>
            <Button size="sm" variant="destructive" onClick={() => {
              setConfirmClose(false);
              discardCompose();
            }}>Discard</Button>
            <Button size="sm" onClick={() => {
              setConfirmClose(false);
              saveDraft();
            }}>Save draft</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
