import { useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "lw.theme"; // read before paint by public/assets/theme.js: keep the key and values in step

/** Light or dark sets data-theme on <html>; System removes it so the CSS follows prefers-color-scheme. */
export function applyTheme(t: Theme): void {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void] {
  // From the theme the page shows, so a choice that could not be saved (storage blocked) still reads right when the menu reopens.
  const [theme, set] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "system";
  });
  return [theme, (t) => (applyTheme(t), set(t))];
}
