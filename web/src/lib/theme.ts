import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "gouvra.theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

let preference: ThemePreference = typeof window === "undefined" ? "system" : readPreference();

export function getThemePreference(): ThemePreference {
  return preference;
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return media().matches ? "dark" : "light";
  return pref;
}

function apply(): void {
  document.documentElement.dataset.theme = resolveTheme(preference);
  listeners.forEach((listener) => {
    listener();
  });
}

/**
 * Change the theme. When the browser supports view transitions and motion is allowed,
 * the new theme is revealed as a circle growing from `origin` (usually the toggle button).
 */
export function setThemePreference(next: ThemePreference, origin?: { x: number; y: number }): void {
  const previous = resolveTheme(preference);
  preference = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    /* storage unavailable (private mode): the choice still applies to this tab */
  }
  const changes = resolveTheme(next) !== previous;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!changes || reduced || typeof document.startViewTransition !== "function" || !origin) {
    apply();
    return;
  }
  const radius = Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y),
  );
  const transition = document.startViewTransition(apply);
  void transition.ready.then(() => {
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${origin.x}px ${origin.y}px)`,
          `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
        ],
      },
      {
        duration: 420,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        pseudoElement: "::view-transition-new(root)",
      },
    );
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const mq = media();
  const onSystemChange = () => {
    if (preference === "system") apply();
  };
  mq.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(listener);
    mq.removeEventListener("change", onSystemChange);
  };
}

export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme } {
  const pref = useSyncExternalStore(
    subscribe,
    () => preference,
    (): ThemePreference => "system",
  );
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolveTheme(preference),
    (): ResolvedTheme => "light",
  );
  return { preference: pref, resolved };
}
