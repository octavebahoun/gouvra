import { useEffect, useRef } from "react";

/**
 * Ctrl/⌘ + Enter runs `handler` while `active` (a dialog is open, a console is shown).
 * Listening on the window keeps the shortcut working from any field, editors included.
 */
export function useModEnter(active: boolean, handler: () => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);
}
