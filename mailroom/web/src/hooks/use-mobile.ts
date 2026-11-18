"use client";

import { useSyncExternalStore } from "react";

/** Live result of a CSS media query; `fallback` during static prerender. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

/** Phones: below Tailwind's `md` breakpoint. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Tablets in portrait and small laptops: `md` up to `lg`. */
export function useIsTablet(): boolean {
  return useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
}

/** A mouse or trackpad is the primary pointer (tooltips and hover actions make sense). */
export function useCanHover(): boolean {
  return useMediaQuery("(hover: hover)", true);
}
