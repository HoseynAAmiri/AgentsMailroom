"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BusEvent, Snapshot, UserState } from "@/lib/types";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const POLL_MS = 5000;
type WireSnapshot = Omit<Snapshot, "tasks"> & { tasks?: Snapshot["tasks"] };

export interface RefreshOptions {
  full?: boolean;
  background?: boolean;
}

export interface BusData {
  snap: Snapshot | null;
  events: BusEvent[];
  snapshotReceivedAt: number | null;
  connected: boolean;
  error: string | null;
  refresh: (opts?: RefreshOptions) => Promise<void>;
  setUserState: (us: UserState) => void;
  appendEvents: (added: BusEvent[]) => void;
}

/** Polls /api/snapshot; after the first full load it asks only for events after the last id it holds. */
export function useBus(): BusData {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [snapshotReceivedAt, setSnapshotReceivedAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastId = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);
  const taskRevision = useRef<string | null>(null);
  const inFlightCount = useRef(0);
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const userStateVersion = useRef(0);

  const refresh = useCallback(async (opts?: RefreshOptions) => {
    if (opts?.background && inFlightCount.current > 0) return;
    const seq = ++requestSeq.current;
    inFlightCount.current += 1;
    const requestedVersion = userStateVersion.current;
    try {
      const q = new URLSearchParams();
      if (!opts?.full) {
        if (lastId.current) q.set("after", lastId.current);
        if (cursor.current) q.set("cursor", cursor.current);
        if (taskRevision.current) q.set("tasks_after", taskRevision.current);
      }
      const res = await fetch(`/api/snapshot${q.size ? `?${q}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as WireSnapshot;
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setSnapshotReceivedAt(Date.now());
      setEvents((prev) => {
        if (data.full) return data.events;
        if (!data.events.length) return prev;
        const seen = new Set(prev.map((e) => e.id));
        const fresh = data.events.filter((e) => !seen.has(e.id));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      lastId.current = data.last_id;
      cursor.current = data.event_cursor ?? null;
      taskRevision.current = data.tasks_revision ?? null;
      // An unchanged task index preserves its identity and avoids rebuilding every thread.
      setSnap((prev) => {
        const previousState = prev?.user_state;
        const keepState = previousState && (requestedVersion !== userStateVersion.current ||
          JSON.stringify(previousState) === JSON.stringify(data.user_state));
        return { ...data, tasks: data.tasks ?? prev?.tasks ?? [], user_state: keepState ? previousState : data.user_state };
      });
      setConnected(true);
      setError(null);
    } catch (err) {
      if (seq >= appliedSeq.current) {
        setConnected(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlightCount.current = Math.max(0, inFlightCount.current - 1);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const onVisibilityChange = () => {
      clearInterval(timer);
      if (document.visibilityState !== "visible") return;
      void refresh();
      timer = setInterval(() => void refresh({ background: true }), POLL_MS);
    };
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  const setUserState = useCallback((us: UserState) => {
    userStateVersion.current += 1;
    setSnap((s) => (s ? { ...s, user_state: us } : s));
  }, []);

  const appendEvents = useCallback((added: BusEvent[]) => {
    if (!added.length) return;
    setEvents((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const fresh = added.filter((e) => !seen.has(e.id));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, []);

  return { snap, events, snapshotReceivedAt, connected, error, refresh, setUserState, appendEvents };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  // Match the static prerender during hydration; restore saved values before the first paint.
  const [value, setValue] = useState<T>(initial);
  useIsomorphicLayoutEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setValue(JSON.parse(raw) as T);
    } catch {
      /* private mode or bad JSON */
    }
  }, [key]);
  const set = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
