"use client";

import { Fragment, type MouseEvent, type ReactNode } from "react";
import { Bot, Code2, FileImage, FileText, FileType, GitCommit, Hash, Link2, MousePointer2, Orbit, Sparkles, Terminal, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { avatarColorId, avatarColorValue, defaultAvatarClass, effectiveState, initials, STATE_DOT } from "@/lib/format";
import { attachmentHref, fileHref, fileKind } from "@/lib/api";
import type { Agent, Ref } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanHover } from "@/hooks/use-mobile";
import { useMailroom } from "./context";

/** Styled (shadcn) tooltip around any truncated text — use instead of a native `title`.
 *  Falls back to a plain span on touch screens (tooltips swallow the first tap there). */
export function Tip({ label, children, className, side }: { label: string; children: ReactNode; className?: string; side?: "top" | "right" | "bottom" | "left" }) {
  const canHover = useCanHover();
  const inner = <span className={cn("min-w-0", className)}>{children}</span>;
  if (!canHover) return inner;
  return (
    <Tooltip>
      <TooltipTrigger render={inner} />
      <TooltipContent side={side}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const AVATAR_BADGE = {
  sm: "-right-0.5 -bottom-[3px] size-1.75",
  md: "-right-px -bottom-0.5 size-2",
  lg: "right-0.5 bottom-0.5 size-2.5",
};

export function AgentAvatar({ id, size = "md", agent, showState }: { id: string; size?: "sm" | "md" | "lg"; agent?: Agent; showState?: boolean }) {
  const { avatarColors } = useMailroom();
  const dim = size === "sm" ? "size-6 text-[10px]" : size === "lg" ? "size-10 text-sm" : "size-8 text-xs";
  const st = agent ? effectiveState(agent) : null;
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={cn("inline-flex items-center justify-center rounded-full font-semibold text-white", dim, defaultAvatarClass(id))}
        style={{ backgroundColor: avatarColorValue(avatarColorId(id, avatarColors?.[id])) }}
      >
        {id === "user" ? <User className="size-[55%]" /> : initials(id)}
      </span>
      {showState && st && (
        <span className={cn(
          "absolute rounded-full ring-2 ring-background",
          AVATAR_BADGE[size],
          STATE_DOT[st] ?? STATE_DOT.idle,
        )} />
      )}
    </span>
  );
}

export function StateDot({ state, className }: { state: string; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", STATE_DOT[state] ?? STATE_DOT.idle, className)} />;
}

const CLI_ICON: Record<string, typeof Bot> = {
  claude: Sparkles,
  codex: Code2,
  "cursor-agent": MousePointer2,
  opencode: Terminal,
  agy: Orbit,
};

export function CliIcon({ cli, className }: { cli?: string | null; className?: string }) {
  const Icon = (cli && CLI_ICON[cli]) || Bot;
  return <Icon className={cn("size-3.5", className)} />;
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-none font-medium", className)}>
      {children}
    </span>
  );
}

/** Plain click opens the in-app viewer; Ctrl/⌘/middle click keeps the browser's new-tab behaviour. */
function viewOnClick(open: () => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  };
}

function FileIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  const Icon = kind === "image" ? FileImage : kind === "pdf" ? FileType : FileText;
  return <Icon className="size-3.5 shrink-0 text-sky-500" />;
}

export function RefChip({ r }: { r: Ref }) {
  const { openEvent, openFile } = useMailroom();
  if (r.kind === "event") {
    return (
      <button type="button" onClick={() => openEvent(r.value)} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent">
        <Link2 className="size-3" /> {r.value}
      </button>
    );
  }
  const href = r.kind === "commit" ? null : fileHref(r.value);
  if (href || r.kind === "file" || r.kind === "path") {
    const name = r.value.split("/").filter(Boolean).pop() || r.value;
    const isImage = /\.(png|jpe?g|gif|svg|webp)$/i.test(name);
    const inner = (
      <>
        {isImage && href ? (
          // 16px inline thumbnail; next/image adds nothing for a static export this small.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={href} alt="" className="size-4 shrink-0 rounded object-cover" />
        ) : (
          <FileIcon name={name} />
        )}
        <span className="max-w-[260px] truncate">{name}</span>
      </>
    );
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener"
        title={r.value}
        onClick={viewOnClick(() => openFile({ href, path: r.value }))}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent touch:py-1.5"
      >
        {inner}
      </a>
    ) : (
      <span title={r.value} className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
        {inner}
      </span>
    );
  }
  const Icon = r.kind === "commit" ? GitCommit : Hash;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
      <Icon className="size-3" />
      {r.kind !== "commit" && <span className="font-sans">{r.kind}:</span>}
      {r.value}
    </span>
  );
}

const TOKEN = /(\be\d{3,}\b|https?:\/\/[^\s)]+|coordination\/attachments\/[^\s,;)]+|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b)/g;

export function RichText({ text, className }: { text: string; className?: string }) {
  const { openEvent, threadByEvent, openFile } = useMailroom();
  const parts = text.split(TOKEN);
  return (
    <div className={cn("text-sm leading-relaxed break-words whitespace-pre-wrap", className)}>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        if (/^e\d{3,}$/.test(p)) {
          return threadByEvent.has(p) ? (
            <button key={i} type="button" onClick={() => openEvent(p)} className="rounded px-0.5 font-medium text-primary hover:underline">
              {p}
            </button>
          ) : (
            <span key={i} className="font-medium">{p}</span>
          );
        }
        if (p.startsWith("http")) {
          return (
            <a key={i} href={p} target="_blank" rel="noopener" className="text-primary underline-offset-2 hover:underline">
              {p}
            </a>
          );
        }
        if (p.startsWith("coordination/attachments/")) {
          const href = attachmentHref(p);
          return href ? (
            <a key={i} href={href} target="_blank" rel="noopener" onClick={viewOnClick(() => openFile({ href, path: p }))} className="text-primary underline-offset-2 hover:underline">
              {p}
            </a>
          ) : (
            <Fragment key={i}>{p}</Fragment>
          );
        }
        return (
          <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
            {p}
          </code>
        );
      })}
    </div>
  );
}
