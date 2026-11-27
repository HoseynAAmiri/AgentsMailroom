"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, ExternalLink, File as FileIcon, Loader2, Maximize, Minus, Plus, WrapText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { attachmentDownloadHref, fileExtension, fileKind, type FileKind } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useMailroom, type ViewedFile } from "@/components/mailroom/context";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Pinch (two fingers) and Ctrl/⌘ + wheel change `zoom`; one-finger scrolling stays native. */
function usePinchZoom(ref: RefObject<HTMLElement | null>, zoom: number, setZoom: (z: number) => void) {
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { d: number; z: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) start = { d: dist(e.touches), z: zoomRef.current };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      setZoom(clamp((start.z * dist(e.touches)) / start.d));
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(clamp(zoomRef.current * Math.exp(-e.deltaY * 0.0025)));
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [ref, setZoom]);
}

// ---------------------------------------------------------------- image

/** Pan and zoom with mouse (wheel, drag, double-click) and touch (pinch, drag, double-tap). */
function ImageView({ src, zoom, setZoom, fitKey }: { src: string; zoom: number; setZoom: (z: number) => void; fitKey: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [panState, setPanState] = useState({ fitKey, x: 0, y: 0 });
  const pan = panState.fitKey === fitKey ? { x: panState.x, y: panState.y } : { x: 0, y: 0 };
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const state = useRef({ zoom, pan, fitKey });
  useEffect(() => {
    state.current = { zoom, pan, fitKey };
  });

  const zoomAt = useCallback(
    (next: number, cx: number, cy: number) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (!box) return;
      const { zoom: z, pan: p, fitKey: fk } = state.current;
      const nz = clamp(next);
      // keep the point under the cursor/fingers fixed
      const ox = cx - box.left - box.width / 2;
      const oy = cy - box.top - box.height / 2;
      const k = nz / z;
      setPanState({ fitKey: fk, x: ox - (ox - p.x) * k, y: oy - (oy - p.y) * k });
      setZoom(nz);
    },
    [setZoom],
  );

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; z: number } | null = null;
    let lastTap = 0;
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: state.current.zoom };
      } else if (e.pointerType === "touch") {
        const now = Date.now();
        if (now - lastTap < 300) zoomAt(state.current.zoom > 1.01 ? 1 : 2.5, e.clientX, e.clientY);
        lastTap = now;
      }
    };
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pointers.set(e.pointerId, cur);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        zoomAt((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (pointers.size === 1) {
        const fk = state.current.fitKey;
        setPanState((p) => {
          const base = p.fitKey === fk ? p : { fitKey: fk, x: 0, y: 0 };
          return { fitKey: fk, x: base.x + cur.x - prev.x, y: base.y + cur.y - prev.y };
        });
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(state.current.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
    };
    const onDbl = (e: MouseEvent) => zoomAt(state.current.zoom > 1.01 ? 1 : 2.5, e.clientX, e.clientY);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("dblclick", onDbl);
    };
  }, [zoomAt]);

  return (
    <div ref={boxRef} className="relative h-full w-full cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing">
      {!loaded && !failed && <Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>}
      {failed && <Centered>Could not load the image.</Centered>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "center", visibility: loaded ? "visible" : "hidden" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- pdf

type PdfDoc = import("pdfjs-dist").PDFDocumentProxy;

function PdfPage({ doc, n, width, zoom }: { doc: PdfDoc; n: number; width: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState(1.414);
  const [renderZoom, setRenderZoom] = useState(zoom);

  // re-render the bitmap shortly after zooming stops; CSS scaling covers the gap
  useEffect(() => {
    const t = setTimeout(() => setRenderZoom(zoom), 180);
    return () => clearTimeout(t);
  }, [zoom]);

  useEffect(() => {
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    let dead = false;
    void doc.getPage(n).then((page) => {
      if (dead || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      setAspect(base.height / base.width);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const scale = Math.min((width * renderZoom * dpr) / base.width, 4096 / base.width);
      const vp = page.getViewport({ scale });
      const c = canvasRef.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => {
      dead = true;
      task?.cancel();
    };
  }, [doc, n, width, renderZoom]);

  const w = width * zoom;
  return <canvas ref={canvasRef} className="mx-auto block bg-white shadow-md" style={{ width: w, height: w * aspect }} />;
}

function PdfView({ src, zoom, setZoom }: { src: string; zoom: number; setZoom: (z: number) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  usePinchZoom(scrollRef, zoom, setZoom);

  useEffect(() => {
    let dead = false;
    let loaded: PdfDoc | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        loaded = await pdfjs.getDocument({ url: src }).promise;
        if (dead) void loaded.cleanup();
        else setDoc(loaded);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      dead = true;
      void loaded?.cleanup();
    };
  }, [src]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth - 24, 1000)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={scrollRef} className="h-full overflow-auto bg-muted/40 p-3 [touch-action:pan-x_pan-y]">
      {error ? (
        <Centered>Could not open the PDF: {error}</Centered>
      ) : !doc || !width ? (
        <Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>
      ) : (
        <div className="flex w-max min-w-full flex-col items-center gap-3">
          {Array.from({ length: Math.min(doc.numPages, 200) }, (_, i) => (
            <PdfPage key={i} doc={doc} n={i + 1} width={width} zoom={zoom} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- text, markdown, json

const MAX_RENDER_CHARS = 1_500_000;

function prettyJson(text: string, jsonl: boolean): string {
  try {
    if (!jsonl) return JSON.stringify(JSON.parse(text), null, 2);
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.stringify(JSON.parse(l), null, 2))
      .join("\n\n");
  } catch {
    return text;
  }
}

/** A relative link in a markdown file, resolved next to that file (null for web links and anchors). */
function resolveLocal(link: string, fileHref: string, filePath: string): ViewedFile | null {
  if (/^([a-z]+:|#|\/)/i.test(link)) return null;
  const clean = link.split("#")[0].split("?")[0];
  if (!clean) return null;
  const join = (base: string) => {
    const out = base.split("/").slice(0, -1);
    for (const p of clean.split("/")) {
      if (p === "..") out.pop();
      else if (p && p !== ".") out.push(p);
    }
    return out.join("/");
  };
  return { href: join(fileHref), path: join(filePath) };
}

function BinaryFallbackView({ name, href, contentType }: { name: string; href: string; contentType?: string }) {
  const ext = fileExtension(name);
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileIcon className="size-10 text-muted-foreground opacity-70" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">
          Preview is not available in the browser for this format{ext ? ` (.${ext})` : ""}.
          {contentType ? ` (${contentType})` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" render={<a href={attachmentDownloadHref(href)} download={name} />} nativeButton={false}>
          <Download /> Download
        </Button>
        <Button size="sm" variant="outline" render={<a href={href} target="_blank" rel="noopener" />} nativeButton={false}>
          <ExternalLink /> Open in new tab
        </Button>
      </div>
    </div>
  );
}

function AudioView({ src }: { src: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-6">
      <audio controls src={src} className="w-full max-w-lg" />
    </div>
  );
}

function VideoView({ src }: { src: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center bg-black/80 p-4">
      <video controls src={src} className="max-h-full max-w-full rounded-md" />
    </div>
  );
}

function TextView({ src, path, kind, name, zoom, setZoom, wrap, raw }: { src: string; path: string; kind: FileKind; name: string; zoom: number; setZoom: (z: number) => void; wrap: boolean; raw: boolean }) {
  const { openFile } = useMailroom();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<{ src: string; text: string | null; binaryType: string | null; error: string | null }>({
    src: "",
    text: null,
    binaryType: null,
    error: null,
  });
  usePinchZoom(scrollRef, zoom, setZoom);

  useEffect(() => {
    let dead = false;
    fetch(src, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "not found on machine A" : `HTTP ${r.status}`);
        const ctype = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const disp = (r.headers.get("content-disposition") || "").toLowerCase();
        if (disp.startsWith("attachment") && !ctype.startsWith("text/") && ctype !== "application/json") {
          return { binary: true as const, contentType: ctype || "application/octet-stream" };
        }
        return { binary: false as const, text: await r.text() };
      })
      .then((res) => {
        if (dead) return;
        if (res.binary) setLoadState({ src, text: null, binaryType: res.contentType, error: null });
        else setLoadState({ src, text: res.text, binaryType: null, error: null });
      })
      .catch((err) => !dead && setLoadState({ src, text: null, binaryType: null, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      dead = true;
    };
  }, [src]);

  const active = loadState.src === src ? loadState : null;
  const text = active?.text ?? null;
  const binaryType = active?.binaryType ?? null;
  const error = active?.error ?? null;

  if (binaryType !== null) {
    return <BinaryFallbackView name={name} href={src} contentType={binaryType} />;
  }

  let body: ReactNode;
  if (error) body = <Centered>Could not open {name}: {error}</Centered>;
  else if (text === null) body = <Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>;
  else {
    const truncated = text.length > MAX_RENDER_CHARS;
    const t = truncated ? text.slice(0, MAX_RENDER_CHARS) : text;
    const shown = kind === "json" && !raw ? prettyJson(t, name.toLowerCase().endsWith(".jsonl")) : t;
    body = (
      <>
        {truncated && <p className="mb-3 rounded-md bg-amber-500/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Large file: showing the first {MAX_RENDER_CHARS.toLocaleString()} characters. Open in a new tab for all of it.</p>}
        {kind === "markdown" && !raw ? (
          <div className="md-view mx-auto max-w-4xl">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  const local = href ? resolveLocal(href, src, path) : null;
                  return local ? (
                    <a href={local.href} onClick={(e) => (e.preventDefault(), openFile(local))}>
                      {children}
                    </a>
                  ) : (
                    <a href={href} target="_blank" rel="noopener">
                      {children}
                    </a>
                  );
                },
                // eslint-disable-next-line @next/next/no-img-element
                img: ({ src: s, alt }) => <img src={typeof s === "string" ? (resolveLocal(s, src, path)?.href ?? s) : undefined} alt={alt ?? ""} />,
                table: ({ children }) => (
                  <div className="md-table">
                    <table>{children}</table>
                  </div>
                ),
              }}
            >
              {shown}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className={cn("font-mono text-[0.8rem] leading-relaxed", wrap ? "break-words whitespace-pre-wrap" : "w-max whitespace-pre")}>{shown}</pre>
        )}
      </>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-auto px-4 py-3 sm:px-6 [touch-action:pan-x_pan-y]" style={{ fontSize: `${zoom}rem` }}>
      {body}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-40 items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

// ---------------------------------------------------------------- dialog

function FileViewerBody({ viewing }: { viewing: ViewedFile }) {
  const [zoom, setZoom] = useState(1);
  const [fitKey, setFitKey] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [raw, setRaw] = useState(false);

  const name = viewing.path.split("/").filter(Boolean).pop() || viewing.path;
  const kind = fileKind(name);
  const step = (k: number) => setZoom((z) => clamp(Math.round(z * k * 100) / 100));
  const reset = () => {
    setZoom(1);
    setFitKey((n) => n + 1);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") step(1.25);
      else if (e.key === "-") step(0.8);
      else if (e.key === "0") reset();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:px-3">
        <div className="min-w-0 flex-1 px-1">
          <DialogPrimitive.Title className="truncate text-sm font-semibold">{name}</DialogPrimitive.Title>
          <p className="truncate font-mono text-[11px] text-muted-foreground" title={viewing.path}>
            {viewing.path}
          </p>
        </div>
        {kind === "markdown" || kind === "json" ? (
          <Button variant="ghost" size="sm" onClick={() => setRaw((r) => !r)} className={cn(raw && "tool-active")}>
            Raw
          </Button>
        ) : null}
        {(kind === "text" || kind === "json" || (kind === "markdown" && raw)) && (
          <Button variant="ghost" size="icon-sm" aria-label="Wrap lines" title="Wrap lines" onClick={() => setWrap((w) => !w)} className={cn("hidden sm:inline-flex", wrap && "tool-active")}>
            <WrapText />
          </Button>
        )}
        {kind !== "binary" && kind !== "audio" && kind !== "video" && (
          <>
            <div className="flex items-center rounded-lg border">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => step(0.8)}>
                <Minus />
              </Button>
              <button type="button" onClick={reset} title="Reset zoom" className="w-11 text-center font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground">
                {Math.round(zoom * 100)}%
              </button>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => step(1.25)}>
                <Plus />
              </Button>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Fit" title="Fit" onClick={reset} className="hidden sm:inline-flex">
              <Maximize />
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Open in new tab" title="Open in new tab" render={<a href={viewing.href} target="_blank" rel="noopener" />} nativeButton={false}>
          <ExternalLink />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Download" title="Download" render={<a href={attachmentDownloadHref(viewing.href)} download={name} />} nativeButton={false} className="hidden sm:inline-flex">
          <Download />
        </Button>
        <DialogPrimitive.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
          <X />
        </DialogPrimitive.Close>
      </div>
      <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        {kind === "image" ? (
          <ImageView src={viewing.href} zoom={zoom} setZoom={setZoom} fitKey={fitKey} />
        ) : kind === "pdf" ? (
          <PdfView src={viewing.href} zoom={zoom} setZoom={setZoom} />
        ) : kind === "audio" ? (
          <AudioView src={viewing.href} />
        ) : kind === "video" ? (
          <VideoView src={viewing.href} />
        ) : kind === "binary" ? (
          <BinaryFallbackView name={name} href={viewing.href} />
        ) : (
          <TextView src={viewing.href} path={viewing.path} kind={kind} name={name} zoom={zoom} setZoom={setZoom} wrap={wrap} raw={raw} />
        )}
      </div>
    </>
  );
}

export function FileViewer() {
  const { viewing, openFile } = useMailroom();
  const close = useCallback(() => openFile(null), [openFile]);

  return (
    <DialogPrimitive.Root open={!!viewing} onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/50 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-popover text-popover-foreground outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 sm:inset-6 sm:rounded-xl sm:ring-1 sm:ring-foreground/10 lg:inset-x-[max(1.5rem,calc(50vw-36rem))]">
          {viewing && <FileViewerBody key={viewing.href} viewing={viewing} />}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
