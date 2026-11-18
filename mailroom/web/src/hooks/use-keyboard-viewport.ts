"use client";

import { useEffect } from "react";

function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "textarea" || (tag === "input" && !["checkbox", "radio", "button", "submit"].includes((el as HTMLInputElement).type)) || el.isContentEditable;
}

/**
 * Keeps the app inside the part of the screen the on-screen keyboard leaves free.
 * Sets `data-kb` and the visual viewport dimensions on <html> while the keyboard is up,
 * and keeps the focused field in view even when the browser leaves the layout viewport unchanged.
 */
export function useKeyboardViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let baseline = vv.height;
    let raf = 0;

    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const focused = isEditable(document.activeElement);
        if (vv.scale > 1.01) return; // page pinch-zoomed: leave the layout alone
        if (!focused || vv.height > baseline) baseline = vv.height;
        const kb = focused && vv.height < baseline - 120;
        if (kb) {
          root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
          root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
          if (!("kb" in root.dataset)) {
            root.dataset.kb = "";
            setTimeout(() => (document.activeElement as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }), 60);
          }
        } else if ("kb" in root.dataset) {
          delete root.dataset.kb;
          root.style.removeProperty("--app-h");
          root.style.removeProperty("--app-top");
        }
      });
    };

    const onOrientation = () => {
      baseline = 0;
      update();
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("focusin", update);
    window.addEventListener("focusout", update);
    window.addEventListener("orientationchange", onOrientation);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("focusin", update);
      window.removeEventListener("focusout", update);
      window.removeEventListener("orientationchange", onOrientation);
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--app-top");
      delete root.dataset.kb;
    };
  }, []);
}
