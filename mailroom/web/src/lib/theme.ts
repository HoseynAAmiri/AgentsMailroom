/**
 * Browser toolbar colors matching the `--background` tokens in globals.css.
 * Set NEXT_PUBLIC_MAILROOM_THEME_KEY at build time to isolate localStorage per deployment.
 */
export const THEME_COLOR = { dark: "#080c11", light: "#f7f9fc" } as const;

export const DEFAULT_THEME_STORAGE_KEY = "agents_mailroom_theme";
export const THEME_STORAGE_KEY =
  process.env.NEXT_PUBLIC_MAILROOM_THEME_KEY?.trim() || DEFAULT_THEME_STORAGE_KEY;

/** Point the `theme-color` and `color-scheme` meta tags at the given theme. */
export function applyThemeMeta(theme: keyof typeof THEME_COLOR) {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute("media");
    m.content = THEME_COLOR[theme];
  });
  const scheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (scheme) scheme.content = theme;
}
