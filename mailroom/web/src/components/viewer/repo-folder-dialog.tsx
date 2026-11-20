"use client";

import { useEffect, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, fileHref, type RepoDirEntry, type RepoDirListing } from "@/lib/api";
import { ago, type TaskDocFolder } from "@/lib/format";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

interface ListingState {
  forPath: string;
  tick: number;
  data: RepoDirListing | null;
  error: string;
}

function RepoFolderBody({
  rootPath,
  title,
  onOpenFile,
}: {
  rootPath: string;
  title?: string;
  onOpenFile: (file: { href: string; path: string }) => void;
}) {
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<ListingState>({
    forPath: "",
    tick: -1,
    data: null,
    error: "",
  });

  useEffect(() => {
    let active = true;
    api
      .repoDir(currentPath)
      .then((data) => {
        if (active) setState({ forPath: currentPath, tick: reloadTick, data, error: "" });
      })
      .catch((cause: unknown) => {
        if (active) {
          setState({
            forPath: currentPath,
            tick: reloadTick,
            data: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [currentPath, reloadTick]);

  const loading = state.forPath !== currentPath || state.tick !== reloadTick;
  const listing = state.forPath === currentPath ? state.data : null;
  const error = state.forPath === currentPath ? state.error : "";

  const subRel = currentPath.startsWith(`${rootPath}/`) ? currentPath.slice(rootPath.length + 1) : "";
  const subParts = subRel ? subRel.split("/").filter(Boolean) : [];
  const canGoUp = subParts.length > 0;
  const parentWithinRoot = subParts.length > 1
    ? `${rootPath}/${subParts.slice(0, -1).join("/")}`
    : rootPath;

  function openEntry(entry: RepoDirEntry) {
    if (entry.kind === "dir") {
      setCurrentPath(entry.path);
      return;
    }
    if (!entry.viewable) return;
    const href = fileHref(entry.path);
    if (href) onOpenFile({ href, path: entry.path });
  }

  return (
    <div data-repo-folder-dialog="true" data-repo-path={currentPath} className="flex min-h-0 flex-col gap-3">
      <DialogHeader className="min-w-0 pr-8">
        <DialogTitle className="flex items-center gap-2 text-base">
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{title ?? rootPath.split("/").at(-1) ?? rootPath}</span>
        </DialogTitle>
        <DialogDescription className="truncate font-mono text-xs" title={currentPath}>
          {currentPath}
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 px-2 py-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!canGoUp}
          aria-label="Up one folder"
          onClick={() => setCurrentPath(parentWithinRoot)}
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
          Up
        </Button>
        <nav aria-label="Folder breadcrumbs" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs">
          <Button
            type="button"
            size="xs"
            variant={subParts.length === 0 ? "secondary" : "ghost"}
            className="h-6 max-w-full px-1.5 font-mono text-xs"
            onClick={() => setCurrentPath(rootPath)}
          >
            <span className="truncate">{title ?? rootPath}</span>
          </Button>
          {subParts.map((part, idx) => {
            const target = `${rootPath}/${subParts.slice(0, idx + 1).join("/")}`;
            const isLast = idx === subParts.length - 1;
            return (
              <span key={target} className="inline-flex items-center gap-1">
                <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />
                <Button
                  type="button"
                  size="xs"
                  variant={isLast ? "secondary" : "ghost"}
                  className="h-6 px-1.5 font-mono text-xs"
                  onClick={() => setCurrentPath(target)}
                >
                  {part}
                </Button>
              </span>
            );
          })}
        </nav>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh folder"
          title="Refresh"
          onClick={() => setReloadTick((n) => n + 1)}
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
        </Button>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="max-h-[55dvh] min-h-40 overflow-y-auto rounded-lg border">
        {loading && !listing ? (
          <p className="p-4 text-sm text-muted-foreground">Loading folder contents…</p>
        ) : listing && listing.entries.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Folder is empty.</p>
        ) : listing ? (
          <ul className="divide-y divide-border/60">
            {listing.entries.map((entry) => {
              const interactive = entry.kind === "dir" || (entry.viewable && !!fileHref(entry.path));
              if (!interactive) {
                return (
                  <li
                    key={entry.path}
                    className="flex min-h-10 items-center justify-between gap-2 px-3 py-2 text-sm text-muted-foreground"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FileText className="size-4 shrink-0 opacity-60" aria-hidden="true" />
                      <span className="truncate font-mono text-xs">{entry.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                      <Badge variant="outline" className="text-[10px]">Not previewable</Badge>
                      <span>{formatBytes(entry.size)}</span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={entry.path}>
                  <button
                    type="button"
                    data-repo-entry={entry.path}
                    onClick={() => openEntry(entry)}
                    className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {entry.kind === "dir" ? (
                        <Folder className="size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                      ) : (
                        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className="truncate font-mono text-xs sm:text-sm">
                        {entry.kind === "dir" ? `${entry.name}/` : entry.name}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                      {entry.kind === "dir" ? (
                        <ChevronRight className="size-4" aria-hidden="true" />
                      ) : (
                        <>
                          <span>{formatBytes(entry.size)}</span>
                          <span className="hidden sm:inline">{ago(entry.modified)}</span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function RepoFolderDialog({
  open,
  rootPath,
  title,
  onOpenChange,
  onOpenFile,
}: {
  open: boolean;
  rootPath: string;
  title?: string;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (file: { href: string; path: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] overflow-hidden sm:max-w-2xl">
        {open && rootPath && (
          <RepoFolderBody key={rootPath} rootPath={rootPath} title={title} onOpenFile={onOpenFile} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function OpenFolderAction({
  folders,
  admin,
  onOpenFolder,
  size = "xs",
  label = "Open folder",
}: {
  folders: readonly TaskDocFolder[];
  admin: boolean;
  onOpenFolder: (folder: TaskDocFolder) => void;
  size?: "xs" | "sm";
  label?: string;
}) {
  if (!admin || folders.length === 0) return null;

  const btnClass = size === "xs"
    ? "h-6 gap-1 px-1.5 text-[11px]"
    : "h-10 gap-1.5 touch:h-11";
  const iconClass = size === "xs" ? "size-3" : "size-4";

  if (folders.length === 1) {
    const only = folders[0];
    return (
      <Button
        type="button"
        size={size}
        variant="outline"
        title={`Browse ${only.folder}`}
        className={btnClass}
        onClick={() => onOpenFolder(only)}
      >
        <FolderOpen className={iconClass} aria-hidden="true" />
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size={size}
            variant="outline"
            title="Choose a task folder to browse"
            className={cn(btnClass, "tabular-nums")}
          >
            <FolderOpen className={iconClass} aria-hidden="true" />
            {label} ({folders.length})
            <ChevronDown className={iconClass} aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[11px]">
            Task folders ({folders.length})
          </DropdownMenuLabel>
          {folders.map((folder) => (
            <DropdownMenuItem
              key={folder.folder}
              title={folder.folder}
              onClick={() => onOpenFolder(folder)}
            >
              <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate font-mono text-xs">{folder.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
