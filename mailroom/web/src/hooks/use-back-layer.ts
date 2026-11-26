"use client";

import { useEffect, useRef } from "react";

/**
 * Browser Back walks the in-app stack (file -> composer -> thread -> folder -> page)
 * across phone, tablet, and desktop, then leaves Mailroom on the very next Back
 * once in-app history is exhausted.
 *
 * Key invariants:
 * - Every in-app history entry carries a per-load session id (`mrSid`) and 1-based
 *   depth (`mrDepth`) above this load's Mailroom root (`mrRoot: true, mrDepth: 0`).
 * - UI closes coalesce in a microtask and issue at most one atomic `history.go(-n)`
 *   over all contiguous trailing closed layers; if a new layer opens in the same
 *   tick, the closed slot is reused in-place via `replaceState`.
 * - Any `pushBack` while an atomic history reconciliation is in flight queues in
 *   `pendingPushes` and is pushed only after `popstate` settles.
 * - `popstate` reconciles against the destination entry (`ev.state`), never blind
 *   `stack.pop()`: it closes skipped layers in LIFO order, skips closed interior
 *   slots, guards Browser Forward onto previously closed slots, and auto-skips stale
 *   Mailroom entries left behind by reloads or legacy sessions.
 */

export type MrHistoryState = Record<string, unknown> & {
  mr?: number;
  mrRoot?: boolean;
  mrSid?: string;
  mrDepth?: number;
};

export interface BackWindowLike {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
    back(): void;
    go(delta?: number): void;
  };
  addEventListener(type: "popstate", listener: (ev: { state: unknown }) => void): void;
  addEventListener(type: "pageshow", listener: (ev: { persisted?: boolean }) => void): void;
  removeEventListener(type: "popstate", listener: (ev: { state: unknown }) => void): void;
  removeEventListener(type: "pageshow", listener: (ev: { persisted?: boolean }) => void): void;
}

type LayerEntry = {
  id: number;
  close: (() => void) | null;
};

type InFlightGo = {
  kind: "collapse-root" | "reconcile";
  targetId: number;
  oldSid?: string;
  remainingHops?: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const RECONCILE_TIMEOUT_MS = 250;

function makeSessionId(): string {
  return `${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function cloneBaseState(st: unknown): Record<string, unknown> {
  if (!st || typeof st !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(st as Record<string, unknown>)) {
    if (key === "mr" || key === "mrRoot" || key === "mrSid" || key === "mrDepth") continue;
    out[key] = value;
  }
  return out;
}

export function isMailroomState(st: unknown): st is MrHistoryState {
  if (!st || typeof st !== "object") return false;
  const s = st as MrHistoryState;
  return s.mrRoot === true || typeof s.mr === "number" || typeof s.mrSid === "string";
}

export interface BackHistoryController {
  readonly sessionId: string;
  ensureRoot(): void;
  pushBack(restore: () => void): () => void;
  canGoBack(): boolean;
  goBack(): void;
  destroy(): void;
}

export function createBackHistoryController(
  win: BackWindowLike,
  opts?: { sessionId?: string; timeoutMs?: number },
): BackHistoryController {
  const SID = opts?.sessionId ?? makeSessionId();
  const timeoutMs = opts?.timeoutMs ?? RECONCILE_TIMEOUT_MS;

  const entries: LayerEntry[] = [];
  const pendingPushes: Array<{ id: number; close: () => void }> = [];
  let seq = 0;
  let initialized = false;
  let listening = false;
  let pruneScheduled = false;
  let inFlightGo: InFlightGo | null = null;
  let destroyed = false;

  const makeRootState = (st: unknown): MrHistoryState => ({
    ...cloneBaseState(st),
    mrRoot: true,
    mrSid: SID,
    mrDepth: 0,
  });

  const makeLayerState = (st: unknown, id: number, depth: number): MrHistoryState => ({
    ...cloneBaseState(st),
    mrRoot: false,
    mr: id,
    mrSid: SID,
    mrDepth: depth,
  });

  const clearInFlight = () => {
    if (!inFlightGo) return;
    if (inFlightGo.timer !== null) clearTimeout(inFlightGo.timer);
    inFlightGo = null;
  };

  const countTrailingDead = (): number => {
    let n = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].close !== null) break;
      n++;
    }
    return n;
  };

  const closeAllLive = () => {
    while (entries.length > 0) {
      const entry = entries.pop()!;
      entry.close?.();
    }
  };

  const flushPendingPushes = () => {
    while (pendingPushes.length > 0 && !inFlightGo) {
      const next = pendingPushes.shift()!;
      entries.push({ id: next.id, close: next.close });
      win.history.pushState(makeLayerState(win.history.state, next.id, entries.length), "");
    }
  };

  const startInFlight = (spec: Omit<InFlightGo, "timer">, delta: number) => {
    clearInFlight();
    const timer = setTimeout(() => {
      if (destroyed || !inFlightGo) return;
      const timedOutKind = inFlightGo.kind;
      inFlightGo = null;
      if (timedOutKind === "collapse-root") {
        // Older entries may have been evicted beyond the browser's session limit.
        win.history.replaceState(makeRootState(win.history.state), "");
        afterSettle();
        return;
      }
      // Best-effort sync of the current slot when history.go() could not traverse.
      if (entries.length === 0) {
        win.history.replaceState(makeRootState(win.history.state), "");
      } else {
        const top = entries[entries.length - 1];
        win.history.replaceState(makeLayerState(win.history.state, top.id, entries.length), "");
      }
      afterSettle();
    }, timeoutMs);
    inFlightGo = { ...spec, timer };
    win.history.go(delta);
  };

  const flushPrune = () => {
    pruneScheduled = false;
    if (destroyed || inFlightGo) return;
    const deadCount = countTrailingDead();
    if (deadCount === 0) return;
    entries.splice(entries.length - deadCount, deadCount);
    const targetId = entries.length > 0 ? entries[entries.length - 1].id : 0;
    startInFlight({ kind: "reconcile", targetId }, -deadCount);
  };

  const afterSettle = () => {
    if (destroyed || inFlightGo) return;
    const deadCount = countTrailingDead();
    if (deadCount === 1 && pendingPushes.length > 0) {
      const next = pendingPushes.shift()!;
      entries[entries.length - 1] = { id: next.id, close: next.close };
      win.history.replaceState(makeLayerState(win.history.state, next.id, entries.length), "");
      flushPendingPushes();
      return;
    }
    if (deadCount > 0) {
      flushPrune();
      return;
    }
    flushPendingPushes();
  };

  const reconcileCurrentState = (st: MrHistoryState) => {
    if (st.mrRoot === true) {
      closeAllLive();
      afterSettle();
      return;
    }
    if (typeof st.mr === "number") {
      const idx = entries.findIndex((e) => e.id === st.mr);
      if (idx >= 0) {
        const popped = entries.splice(idx + 1);
        for (let k = popped.length - 1; k >= 0; k--) {
          popped[k].close?.();
        }
        const deadCount = countTrailingDead();
        if (deadCount > 0) {
          flushPrune();
          return;
        }
        afterSettle();
        return;
      }
      // Browser Forward landed on a previously popped entry from this session.
      const depth = typeof st.mrDepth === "number" && st.mrDepth > entries.length ? st.mrDepth : entries.length + 1;
      const delta = Math.max(1, depth - entries.length);
      const targetId = entries.length > 0 ? entries[entries.length - 1].id : 0;
      startInFlight({ kind: "reconcile", targetId }, -delta);
    }
  };

  const onPopState = (ev: { state: unknown }) => {
    if (destroyed) return;
    const st = ev.state as MrHistoryState | null;

    if (inFlightGo) {
      if (inFlightGo.kind === "collapse-root") {
        const isOldRoot =
          st?.mrRoot === true &&
          (st.mrDepth === 0 || (inFlightGo.oldSid !== undefined && st.mrSid === inFlightGo.oldSid && st.mrDepth === undefined));
        if (isOldRoot) {
          clearInFlight();
          win.history.replaceState(makeRootState(st), "");
          afterSettle();
          return;
        }
        if (!isMailroomState(st)) {
          clearInFlight();
          closeAllLive();
          pendingPushes.length = 0;
          return;
        }
        if (st.mrSid !== SID) {
          if (typeof st.mrDepth === "number" && st.mrDepth > 0 && (inFlightGo.remainingHops ?? 0) > 0) {
            const hops = (inFlightGo.remainingHops ?? 1) - 1;
            const oldSid = inFlightGo.oldSid;
            startInFlight({ kind: "collapse-root", targetId: 0, oldSid, remainingHops: hops }, -st.mrDepth);
            return;
          }
          clearInFlight();
          win.history.back();
          return;
        }
        clearInFlight();
      } else {
        const landedId =
          st?.mrSid === SID
            ? st.mrRoot === true
              ? 0
              : typeof st.mr === "number"
                ? st.mr
                : -1
            : -1;
        if (landedId === inFlightGo.targetId) {
          clearInFlight();
          afterSettle();
          return;
        }
        // User Back overshot during in-flight reconciliation: clear and reconcile destination.
        clearInFlight();
      }
    }

    if (st && isMailroomState(st) && st.mrSid === SID) {
      reconcileCurrentState(st);
      return;
    }

    if (isMailroomState(st)) {
      // Stale entry from a previous reload or legacy pre-SID session: close any active
      // layers and keep backing out until we reach this load's Root or leave Mailroom.
      closeAllLive();
      pendingPushes.length = 0;
      win.history.back();
      return;
    }

    // Left Mailroom for a non-Mailroom document.
    closeAllLive();
    pendingPushes.length = 0;
  };

  const onPageShow = (ev: { persisted?: boolean }) => {
    if (destroyed || !ev.persisted || inFlightGo) return;
    const st = win.history.state;
    if (isMailroomState(st) && st.mrSid === SID) {
      reconcileCurrentState(st);
    }
  };

  const installListeners = () => {
    if (listening) return;
    listening = true;
    win.addEventListener("popstate", onPopState);
    win.addEventListener("pageshow", onPageShow);
  };

  const ensureRoot = () => {
    installListeners();
    if (initialized) return;
    initialized = true;

    const st = win.history.state as MrHistoryState | null;
    if (st && st.mrSid !== SID && typeof st.mrDepth === "number" && st.mrDepth > 0) {
      // Reload occurred on top of in-app history: collapse back to the existing Root entry
      // so exhausting in-app history always exits to the prior page on the next Back.
      startInFlight(
        { kind: "collapse-root", targetId: 0, oldSid: st.mrSid, remainingHops: 4 },
        -st.mrDepth,
      );
      return;
    }

    // Fresh load, reload at depth 0, or legacy pre-mrSid/mrDepth entry (which Back auto-skips).
    win.history.replaceState(makeRootState(st), "");
  };

  const drop = (id: number) => {
    const pIdx = pendingPushes.findIndex((p) => p.id === id);
    if (pIdx >= 0) {
      pendingPushes.splice(pIdx, 1);
      return;
    }
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) return; // already closed by popstate
    entries[i].close = null;
    if (i === entries.length - 1 && !inFlightGo && !pruneScheduled) {
      pruneScheduled = true;
      queueMicrotask(flushPrune);
    }
  };

  const pushBack = (restore: () => void): (() => void) => {
    ensureRoot();
    const id = ++seq;
    if (inFlightGo) {
      pendingPushes.push({ id, close: restore });
      return () => drop(id);
    }
    if (entries.length > 0 && entries[entries.length - 1].close === null) {
      // Top entry was just UI-closed in this tick; reuse its history slot in-place.
      entries[entries.length - 1] = { id, close: restore };
      win.history.replaceState(makeLayerState(win.history.state, id, entries.length), "");
      return () => drop(id);
    }
    entries.push({ id, close: restore });
    win.history.pushState(makeLayerState(win.history.state, id, entries.length), "");
    return () => drop(id);
  };

  const canGoBack = (): boolean =>
    entries.some((e) => e.close !== null) || pendingPushes.some((e) => e.close !== null);

  const goBack = (): void => {
    if (canGoBack()) win.history.back();
  };

  const destroy = (): void => {
    destroyed = true;
    clearInFlight();
    if (listening) {
      listening = false;
      win.removeEventListener("popstate", onPopState);
      win.removeEventListener("pageshow", onPageShow);
    }
    entries.length = 0;
    pendingPushes.length = 0;
  };

  return {
    get sessionId() {
      return SID;
    },
    ensureRoot,
    pushBack,
    canGoBack,
    goBack,
    destroy,
  };
}

let singleton: BackHistoryController | null = null;

function getController(): BackHistoryController | null {
  if (typeof window === "undefined") return null;
  if (!singleton) {
    singleton = createBackHistoryController(window as unknown as BackWindowLike);
  }
  return singleton;
}

export function canGoBack(): boolean {
  return getController()?.canGoBack() ?? false;
}

export function goBack(): void {
  getController()?.goBack();
}

export function pushBack(restore: () => void): () => void {
  const ctrl = getController();
  if (!ctrl) return () => {};
  return ctrl.pushBack(restore);
}

export function useBackLayer(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });

  useEffect(() => {
    if (!open) return;
    return pushBack(() => closeRef.current());
  }, [open]);
}

/** Pin a root history entry so in-app pushes have a page to return to. */
export function useHistoryRoot() {
  useEffect(() => {
    getController()?.ensureRoot();
  }, []);
}
