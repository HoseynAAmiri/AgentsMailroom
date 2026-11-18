/**
 * Same values as the run dashboard (dashboard/src/lib/themeColors.ts): sRGB of the `--background`
 * tokens in globals.css, used for the mobile browser toolbar.
 */
export const THEME_COLOR = { dark: "#080c11", light: "#f7f9fc" } as const;

export const THEME_STORAGE_KEY = "agents_mailroom_theme";

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
