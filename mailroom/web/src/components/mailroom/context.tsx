"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, type OutgoingMessage } from "@/lib/api";
import { useBus, useLocalStorage } from "@/hooks/use-bus";
import { pushBack, useBackLayer, useHistoryRoot } from "@/hooks/use-back-layer";
import {
  buildThreads,
  mailState,
  openHumanRequests,
  snippet,
  type FolderId,
  type MailState,
  type Thread,
} from "@/lib/threads";
import type { Agent, BusEvent, Snapshot } from "@/lib/types";
import { displayName } from "@/lib/format";

export type View = "goals" | "mail" | "team" | "machine" | "files";
export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeDraft {
  mode: ComposeMode;
  to: string;
  cc: string[];
  subject: string;
  taskId: string;
  inReplyTo: string | null;
  body: string;
  threadKey: string | null;
  refs: { kind: string; value: string }[];
}

interface Ctx {
  snap: Snapshot | null;
  events: BusEvent[];
  connected: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshActiveView: () => Promise<void>;
  registerViewRefresh: (view: View, handler: () => Promise<void>) => () => void;
  agents: Map<string, Agent>;
  avatarColors: Record<string, string>;
  setAvatarColor: (agentId: string, colorId: string | null) => void;
  ms: MailState;
  threads: Thread[];
  threadByEvent: Map<string, Thread>;
  openHuman: BusEvent[];
  openHumanIds: Set<string>;
  view: View;
  setView: (v: View) => void;
  folder: FolderId;
  setFolder: (f: FolderId) => void;
  selected: string | null;
  select: (key: string | null, opts?: { markRead?: boolean }) => void;
  focusEvent: string | null;
  openEvent: (id: string) => void;
  search: string;
  setSearch: (s: string) => void;
  taskFilter: string;
  setTaskFilter: (s: string) => void;
  compose: ComposeDraft | null;
  savedDraft: ComposeDraft | null;
  saveDraft: () => void;
  startCompose: (mode: ComposeMode, source?: BusEvent | null, preset?: Partial<ComposeDraft>) => void;
  updateCompose: (patch: Partial<ComposeDraft>) => void;
  discardCompose: () => void;
  send: () => Promise<boolean>;
  sending: boolean;
  mark: (action: Parameters<typeof api.userState>[0], ids: string[]) => Promise<void>;
  summonOpen: boolean;
  setSummonOpen: (v: boolean) => void;
  navOpen: boolean;
  setNavOpen: (v: boolean) => void;
  viewing: ViewedFile | null;
  openFile: (f: ViewedFile | null) => void;
}

/** A file shown in the in-app viewer: `href` is an /attach/ or /repo/ URL, `path` the ref as written. */
export interface ViewedFile {
  href: string;
  path: string;
}

const MailroomContext = createContext<Ctx | null>(null);

export function useMailroom(): Ctx {
  const c = useContext(MailroomContext);
  if (!c) throw new Error("useMailroom outside provider");
  return c;
}

const EMPTY_DRAFT: ComposeDraft = {
  mode: "new",
  to: "a1",
  cc: [],
  subject: "",
  taskId: "",
  inReplyTo: null,
  body: "",
  threadKey: null,
  refs: [],
};

const MAILBOX_FEEDBACK = {
  delete: "Moved to Deleted items",
  restore: "Restored to mail",
  archive: "Moved to Archive",
  unarchive: "Moved back to conversations",
  flag: "Flag added",
  unflag: "Flag removed",
  read_all: "Marked all as read",
} as const;

export function MailroomProvider({ children }: { children: ReactNode }) {
  const { snap, events, connected, error, refresh, setUserState } = useBus();
  const [view, setViewRaw] = useLocalStorage<View>("mr-view", "mail");
  const [avatarColors, setAvatarColors] = useLocalStorage<Record<string, string>>("mr-avatar-colors", {});
  const setAvatarColor = (agentId: string, colorId: string | null) => {
    setAvatarColors((current) => {
      const next = { ...current };
      if (colorId === null) delete next[agentId];
      else next[agentId] = colorId;
      return next;
    });
  };
  const viewRefresh = useRef<Partial<Record<View, () => Promise<void>>>>({});
  const registerViewRefresh = useCallback((target: View, handler: () => Promise<void>) => {
    viewRefresh.current[target] = handler;
    return () => {
      if (viewRefresh.current[target] === handler) delete viewRefresh.current[target];
    };
  }, []);
  const refreshActiveView = useCallback(async () => {
    await Promise.all([refresh(), viewRefresh.current[view]?.()]);
  }, [refresh, view]);
  const [folder, setFolderRaw] = useLocalStorage<FolderId>("mr-folder", "all");
  const [selected, setSelected] = useState<string | null>(null);
  const [focusEvent, setFocusEvent] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [taskFilter, setTaskFilter] = useLocalStorage("mr-task-filter", "attention");
  const [draft, setCompose] = useLocalStorage<ComposeDraft | null>("mr-draft", null);
  const [draftClosed, setDraftClosed] = useLocalStorage("mr-draft-closed", false);
  const compose = draftClosed ? null : draft;
  const savedDraft = draftClosed ? draft : null;
  const [sending, setSending] = useState(false);
  const [summonOpen, setSummonOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [viewing, setViewing] = useState<ViewedFile | null>(null);

  /** Mail / Team / Machines / Files — Back returns to the previous page. */
  const setView = useCallback(
    (v: View) => {
      if (v === view) return;
      const prev = view;
      setViewRaw(v);
      pushBack(() => setViewRaw(prev));
    },
    [view, setViewRaw],
  );

  /** Open a file, or pass null to close the viewer (Phone Back also closes it). */
  const openFile = useCallback((f: ViewedFile | null) => setViewing(f), []);

  const agents = useMemo(() => new Map((snap?.agents ?? []).map((a) => [a.id, a])), [snap?.agents]);
  const ms = useMemo(() => mailState(snap?.user_state), [snap?.user_state]);
  const threads = useMemo(() => buildThreads(events, snap?.tasks ?? []), [events, snap?.tasks]);
  const threadByEvent = useMemo(() => {
    const m = new Map<string, Thread>();
    for (const t of threads) for (const e of t.events) m.set(e.id, t);
    return m;
  }, [threads]);
  const openHuman = useMemo(() => openHumanRequests(events), [events]);
  const openHumanIds = useMemo(() => new Set(openHuman.map((e) => e.id)), [openHuman]);

  const mark = useCallback(
    async (action: Parameters<Ctx["mark"]>[0], ids: string[]) => {
      if (!ids.length && action !== "read_all") return;
      try {
        setUserState(await api.userState(action, ids));
        if (action in MAILBOX_FEEDBACK) {
          toast.success(MAILBOX_FEEDBACK[action as keyof typeof MAILBOX_FEEDBACK]);
        }
      } catch (err) {
        toast.error(`Could not update mailbox: ${err instanceof Error ? err.message : err}`);
      }
    },
    [setUserState],
  );

  const select = useCallback(
    (key: string | null, opts?: { markRead?: boolean }) => {
      setSelected(key);
      setFocusEvent(null);
      if (key && opts?.markRead !== false) {
        const t = threads.find((x) => x.key === key);
        const ids = t?.events.filter(ms.isUnread).map((e) => e.id) ?? [];
        if (ids.length) void mark("read", ids);
      }
    },
    [threads, ms, mark],
  );

  const setFolder = useCallback(
    (f: FolderId) => {
      const prev = { folder, selected, view, focusEvent };
      if (f === folder && view === "mail" && !selected) {
        setNavOpen(false);
        return;
      }
      setFolderRaw(f);
      setSelected(null);
      setFocusEvent(null);
      setViewRaw("mail");
      setNavOpen(false);
      pushBack(() => {
        setFolderRaw(prev.folder);
        setSelected(prev.selected);
        setFocusEvent(prev.focusEvent);
        setViewRaw(prev.view);
      });
    },
    [folder, selected, view, focusEvent, setFolderRaw, setViewRaw],
  );

  const openEvent = useCallback(
    (id: string) => {
      const t = threadByEvent.get(id);
      if (!t) {
        toast.message(`${id} is not a conversation message (status line or unknown id)`);
        return;
      }
      setView("mail");
      if (ms.isDeleted(t.events.find((e) => e.id === id)!)) setFolderRaw("deleted");
      else if (t.events.filter((e) => !ms.isDeleted(e)).every(ms.isArchived)) setFolderRaw("archive");
      else setFolderRaw("all");
      setSelected(t.key);
      setFocusEvent(id);
    },
    [threadByEvent, ms, setFolderRaw, setView],
  );

  const resumeDraft = useCallback(() => setDraftClosed(false), [setDraftClosed]);
  const saveDraft = useCallback(() => {
    setDraftClosed(true);
    toast.success("Draft saved");
  }, [setDraftClosed]);

  const startCompose = useCallback(
    (mode: ComposeMode, source?: BusEvent | null, preset?: Partial<ComposeDraft>) => {
      setView("mail");
      if (draft) {
        resumeDraft();
        if (mode !== "new" || preset) toast("Existing draft opened. Send or discard it before starting another message.");
        return;
      }
      resumeDraft();
      if (!source || mode === "new") {
        setCompose({ ...EMPTY_DRAFT, ...preset, mode: "new" });
        return;
      }
      const t = threadByEvent.get(source.id);
      const subject = source.subject || t?.subject || source.task_id || "";
      if (snap?.capabilities?.admin && preset?.taskId === undefined) {
        void api.goalTag(source.id).then((tag) => {
          if (!tag.override) return;
          setCompose((current) => current?.inReplyTo === source.id && current.taskId === (source.task_id ?? "")
            ? { ...current, taskId: tag.task_id ?? "" } : current);
        }).catch(() => {});
      }
      if (mode === "forward") {
        const header = `---------- Forwarded ${source.id} ----------\nFrom: ${displayName(source.from, agents)}\nTo: ${displayName(source.to, agents)}${source.cc?.length ? `\nCc: ${source.cc.join(", ")}` : ""}\nDate: ${source.ts}\n\n${source.body}`;
        setCompose({
          ...EMPTY_DRAFT,
          mode,
          to: "",
          subject: subject ? `Fwd: ${subject.replace(/^Fwd:\s*/i, "")}` : "",
          taskId: source.task_id ?? "",
          inReplyTo: source.id,
          body: `\n\n${header}`,
          threadKey: t?.key ?? null,
          refs: [{ kind: "event", value: source.id }],
          ...preset,
        });
        return;
      }
      const other = source.from === "user" ? source.to : source.from;
      const cc =
        mode === "replyAll"
          ? [source.to, ...(source.cc ?? [])].filter((x) => x && x !== "user" && x !== other && x !== "*")
          : [];
      setCompose({
        ...EMPTY_DRAFT,
        mode,
        to: other,
        cc: [...new Set(cc)],
        subject,
        taskId: source.task_id ?? "",
        inReplyTo: source.id,
        body: "",
        threadKey: t?.key ?? null,
        refs: [],
        ...preset,
      });
    },
    [threadByEvent, agents, draft, resumeDraft, setCompose, setView, snap?.capabilities?.admin],
  );

  const updateCompose = useCallback(
    (patch: Partial<ComposeDraft>) => setCompose((c) => (c ? { ...c, ...patch } : c)),
    [setCompose],
  );
  const discardCompose = useCallback(() => {
    setCompose(null);
    toast("Draft discarded");
  }, [setCompose]);

  // Root history entry + Phone Back stack (file → composer → thread → folder → page).
  useHistoryRoot();
  useBackLayer(!!selected, () => {
    setSelected(null);
    setFocusEvent(null);
  });
  useBackLayer(!!compose, saveDraft);
  useBackLayer(!!viewing, () => setViewing(null));
  useBackLayer(summonOpen, () => setSummonOpen(false));

  const send = useCallback(async () => {
    if (!compose) return false;
    const body = compose.body.trim();
    if (!compose.to) {
      toast.error("Choose a recipient in To");
      return false;
    }
    if (!body) {
      toast.error("The message is empty");
      return false;
    }
    setSending(true);
    try {
      const msg: OutgoingMessage = {
        to: compose.to,
        cc: compose.cc.filter((c) => c !== compose.to),
        subject: compose.subject.trim() || null,
        task_id: compose.taskId.trim() || null,
        in_reply_to: compose.inReplyTo,
        body,
        refs: compose.refs,
      };
      const ev = await api.send(msg);
      toast.success(`Sent ${ev.id} to ${[ev.to, ...(ev.cc ?? [])].join(", ")}`, { description: snippet(ev.body, 90) });
      setCompose(null);
      await refresh();
      const t = buildThreads([...events, ev], snap?.tasks ?? []).find((x) => x.events.some((e) => e.id === ev.id));
      if (t) {
        setSelected(t.key);
        setFocusEvent(ev.id);
      }
      return true;
    } catch (err) {
      toast.error(`Not sent: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      setSending(false);
    }
  }, [compose, refresh, setCompose, events, snap?.tasks]);

  const value: Ctx = {
    snap,
    events,
    connected,
    error,
    refresh,
    refreshActiveView,
    registerViewRefresh,
    agents,
    avatarColors,
    setAvatarColor,
    ms,
    threads,
    threadByEvent,
    openHuman,
    openHumanIds,
    view,
    setView,
    folder,
    setFolder,
    selected,
    select,
    focusEvent,
    openEvent,
    search,
    setSearch,
    taskFilter,
    setTaskFilter,
    compose,
    savedDraft,
    saveDraft,
    startCompose,
    updateCompose,
    discardCompose,
    send,
    sending,
    mark,
    summonOpen,
    setSummonOpen,
    navOpen,
    setNavOpen,
    viewing,
    openFile,
  };
  return <MailroomContext.Provider value={value}>{children}</MailroomContext.Provider>;
}
