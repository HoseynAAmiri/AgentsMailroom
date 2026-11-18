"use client";

import { useEffect, useRef } from "react";

/**
 * Phone Back walks the in-app stack (file → composer → thread → folder → page).
 *
 * Opening → pushState. Phone Back → popstate → close().
 * UI close (X) → clear React state; if that layer is still on top of the browser
 * history, drop exactly one entry with a suppressed popstate (never double-pop).
 * If a newer entry was already pushed (e.g. setFolder after clearing a thread), the
 * leftover entry is marked a no-op and auto-skipped on the next Back.
 */
type Layer = { id: number; close: () => void };

const stack: Layer[] = [];
const noopIds = new Set<number>();
let seq = 0;
let listening = false;
let suppressPops = 0;

function ensureListen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", (ev) => {
    if (suppressPops > 0) {
      suppressPops--;
      return;
    }
    const id = (ev.state as { mr?: number } | null)?.mr;
    if (id != null && noopIds.has(id)) {
      noopIds.delete(id);
      // Skip orphaned entry left behind when a newer layer was pushed first.
      window.history.back();
      return;
    }
    stack.pop()?.close();
  });
}

function dropFromStack(id: number) {
  const i = stack.findIndex((l) => l.id === id);
  if (i < 0) return; // already closed by Phone Back
  const onTop = i === stack.length - 1;
  stack.splice(i, 1);
  if (onTop) {
    suppressPops++;
    window.history.back();
  } else {
    noopIds.add(id);
  }
}

export function canGoBack(): boolean {
  return stack.length > 0;
}

export function goBack(): void {
  if (stack.length) window.history.back();
}

export function pushBack(restore: () => void): () => void {
  ensureListen();
  const id = ++seq;
  stack.push({ id, close: restore });
  // Preserve the router's state so closing a layer doesn't reload the document.
  window.history.pushState({ ...window.history.state, mrRoot: false, mr: id }, "");
  return () => dropFromStack(id);
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
    ensureListen();
    const st = window.history.state as { mr?: number; mrRoot?: boolean } | null;
    if (!st?.mrRoot && st?.mr == null) {
      window.history.replaceState({ ...st, mrRoot: true }, "");
    }
  }, []);
}
