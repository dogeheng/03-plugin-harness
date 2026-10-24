import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolve(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return media?.matches ? "dark" : "light";
  return pref;
}

interface ThemeState {
  pref: ThemePref;
  theme: "light" | "dark";
  setPref(p: ThemePref): void;
}

const initialPref = ((): ThemePref => {
  const v = typeof localStorage !== "undefined" ? localStorage.getItem("harness.theme") : null;
  return v === "light" || v === "dark" ? v : "system";
})();

export const useTheme = create<ThemeState>((set) => ({
  pref: initialPref,
  theme: resolve(initialPref),
  setPref: (pref) => {
    localStorage.setItem("harness.theme", pref);
    set({ pref, theme: resolve(pref) });
  },
}));

export function applyThemeClass(theme: "light" | "dark"): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

media?.addEventListener("change", () => {
  const { pref } = useTheme.getState();
  if (pref === "system") useTheme.setState({ theme: resolve("system") });
});

const TOKEN_NAMES = ["bg", "bg-subtle", "card", "fg", "muted", "border", "accent", "accent-fg", "success", "warning", "danger", "radius", "font", "mono"] as const;

/** Current design tokens, as sent to plugin panels in hostContext.tokens (--hx-<name>). */
export function panelTokens(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of TOKEN_NAMES) out[n] = css.getPropertyValue(`--${n}`).trim();
  return out;
}
