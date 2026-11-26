"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FileImage, FileText, FileType, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { ago, fullTime } from "@/lib/format";
import type { Attachment } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchableSelect, type SearchOption } from "@/components/ui/searchable-select";
import { Tip } from "@/components/mailroom/bits";
import { FILES_HEADER_CLS, FILES_TOOLBAR_CLS, FilesSkeleton } from "@/components/mailroom/page-skeletons";
import { useMailroom } from "@/components/mailroom/context";

type Kind = "image" | "pdf" | "data";
type FileSort = "newest" | "oldest" | "name" | "size";

const FILE_SORTS: SearchOption<FileSort>[] = [
  { value: "newest", label: "Newest first", triggerLabel: "Newest" },
  { value: "oldest", label: "Oldest first", triggerLabel: "Oldest" },
  { value: "name", label: "By name", triggerLabel: "Name" },
  { value: "size", label: "By size", triggerLabel: "Size" },
];
const FILE_PAGE_SIZE = 60;

function icon(name: string) {
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return FileImage;
  if (/\.pdf$/i.test(name)) return FileType;
  return FileText;
}

function kind(name: string): Kind {
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return "image";
  if (/\.pdf$/i.test(name)) return "pdf";
  return "data";
}

function size(n: number) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`;
}

const KIND_LABEL: Record<Kind, string> = { image: "Images", pdf: "PDFs", data: "Data & text" };

export function FilesView() {
  const { search, events, openEvent, openFile, snap, registerViewRefresh } = useMailroom();
  const [linkPath, setLinkPath] = useState("");
  const [linkTask, setLinkTask] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkChoices, setLinkChoices] = useState<{ id: string; title: string }[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [type, setType] = useState<"all" | Kind>("all");
  const [folder, setFolder] = useState("all");
  const [cited, setCited] = useState("all");
  const [sort, setSort] = useState<FileSort>("newest");

  const [page, setPage] = useState({ filterKey: "", limit: FILE_PAGE_SIZE });
  const filterKey = JSON.stringify([search, type, folder, cited, sort]);
  const limit = page.filterKey === filterKey ? page.limit : FILE_PAGE_SIZE;

  const load = useCallback((refresh = false) => {
    setLoading(true);
    return api
      .attachments(refresh)
      .then((rows) => {
        setFiles(rows);
        setLoadError("");
      })
      .catch((cause) => {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
        toast.error("Could not load attachments");
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);
  useEffect(() => registerViewRefresh("files", () => load(true)), [load, registerViewRefresh]);

  const citedBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) for (const r of e.refs ?? []) if (r.kind === "file") m.set(r.value.replace(/^.*coordination\/attachments\//, ""), e.id);
    return m;
  }, [events]);

  const folders = useMemo(() => [...new Set(files.map((f) => (f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "")))].sort(), [files]);
  const citers = useMemo(() => [...new Set(citedBy.values())].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })), [citedBy]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = files.filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false;
      if (type !== "all" && kind(f.name) !== type) return false;
      if (folder !== "all" && (f.name.includes("/") ? f.name.slice(0, f.name.lastIndexOf("/")) : "") !== folder) return false;
      if (cited !== "all" && citedBy.get(f.name) !== cited) return false;
      return true;
    });
    out = out.slice().sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (sort === "size") return b.size - a.size;
      if (sort === "oldest") return a.modified.localeCompare(b.modified);
      return b.modified.localeCompare(a.modified);
    });
    return out;
  }, [files, search, type, folder, cited, citedBy, sort]);

  const chip = (on: boolean) =>
    cn("rounded-full border px-2.5 py-0.5 text-xs", on ? "tool-active border-transparent" : "hover:bg-muted");

  return (
    <div className="flex h-full flex-col">
      <div className={FILES_HEADER_CLS}>
        <h2 className="text-base font-semibold">Attachments</h2>
        <span className="hidden text-sm text-muted-foreground sm:inline">coordination/attachments · {list.length} files</span>
        {loading && files.length > 0 && <span role="status" className="ml-auto text-xs text-muted-foreground">Refreshing…</span>}
      </div>
      <div className={FILES_TOOLBAR_CLS}>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={chip(type === "all")} onClick={() => setType("all")}>
            All
          </button>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <button key={k} type="button" className={chip(type === k)} onClick={() => setType(type === k ? "all" : k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <SearchableSelect compact label="Filter by folder" searchPlaceholder="Find a folder…"
            value={folder} onChange={setFolder} options={[
              { value: "all", label: "Any folder", triggerLabel: "Folder" },
              ...folders.filter(Boolean).map((path) => ({ value: path, label: path, triggerLabel: path.split("/").pop() })),
            ]} />
          <SearchableSelect compact label="Filter by citing email" searchPlaceholder="Find an email by ID…"
            value={cited} onChange={setCited} options={[
              { value: "all", label: "Any email", triggerLabel: "Email" },
              ...citers.map((id) => ({ value: id, label: `Cited in ${id}`, triggerLabel: id })),
            ]} />
          <SearchableSelect compact label="Sort" searchPlaceholder="Find a sort order…"
            value={sort} onChange={setSort} options={FILE_SORTS} />
        </div>
      </div>
      {loadError && <div role="alert" className="shrink-0 border-b px-3 py-2 text-sm text-destructive sm:px-4">{loadError}</div>}
      <ScrollArea className="min-h-0 flex-1">
        {loading && files.length === 0 ? <FilesSkeleton /> : <>
        <div className="divide-y">
          {list.slice(0, limit).map((f) => {
            const Icon = icon(f.name);
            const ev = citedBy.get(f.name);
            const href = `/attach/${f.name.split("/").map(encodeURIComponent).join("/")}`;
            return (
              <div key={f.name} className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/50 sm:px-4 sm:py-2">
                <Icon className="size-4 shrink-0 text-sky-500" />
                <Tip label={f.name} side="top" className="min-w-0 flex-1">
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => {
                      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      openFile({ href, path: `coordination/attachments/${f.name}` });
                    }}
                    className="block truncate hover:underline"
                  >
                    {f.name}
                  </a>
                </Tip>
                {ev && (
                  <Tip label={`Open email ${ev}`} className="shrink-0">
                    <button type="button" onClick={() => openEvent(ev)} className="text-xs text-primary hover:underline">
                      cited in {ev}
                    </button>
                  </Tip>
                )}
                {snap?.capabilities?.admin && <Button size="icon-sm" variant="ghost" aria-label={`Link ${f.name} to a task`} title="Link to a task" onClick={async () => {
                  setLinkPath(`coordination/attachments/${f.name}`);
                  setLinkTask("");
                  try { setLinkChoices((await api.goalChoices()).tasks); }
                  catch (cause) { toast.error(String(cause)); }
                }}><Link2 /></Button>}
                <Tip label={`${f.size.toLocaleString()} bytes`} className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                  {size(f.size)}
                </Tip>
                <Tip label={fullTime(f.modified)} className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                  {ago(f.modified)}
                </Tip>
              </div>
            );
          })}
          {!loadError && list.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
              <FileText className="size-10 opacity-40" />
              No attachments match.
            </div>
          )}
        </div>
        {list.length > limit && (
          <div className="py-3 text-center">
            <Button variant="ghost" onClick={() => setPage({ filterKey, limit: limit + FILE_PAGE_SIZE })}>
              Show {Math.min(FILE_PAGE_SIZE, list.length - limit)} more of {list.length - limit}
            </Button>
          </div>
        )}
        </>}
      </ScrollArea>
      <Dialog open={!!linkPath} onOpenChange={(open) => { if (!open && !linkBusy) setLinkPath(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Link file to a task</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{linkPath}</p>
          <form className="grid min-w-0 gap-3" onSubmit={async (event) => {
            event.preventDefault();
            if (!linkTask || linkBusy) return;
            setLinkBusy(true);
            try {
              const result = await api.linkGoalFile(linkTask, linkPath);
              if (result.export_warning) toast.warning(result.export_warning);
              else toast.success(`Linked to ${linkTask}`);
              setLinkPath("");
            } catch (cause) { toast.error(String(cause)); }
            finally { setLinkBusy(false); }
          }}>
            <SearchableSelect label="Task" placeholder="Choose a task" searchPlaceholder="Find a task by ID or title…"
              value={linkTask || null} onChange={setLinkTask} disabled={linkBusy} options={[
              ...linkChoices.map((item) => ({ value: item.id, label: `${item.id} · ${item.title}` })),
            ]} />
            <DialogFooter><Button type="submit" disabled={!linkTask || linkBusy}>Link file</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
