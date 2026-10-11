import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

/** Same rule as AnimatedOutlet: tabs inside a page (deeper segments) are not a new page. */
function sectionOf(pathname: string): string {
  return pathname.split("/").slice(0, 4).join("/");
}

/**
 * After a client-side navigation, move focus to the new page's main heading (or to <main>), so
 * keyboard and screen-reader users start reading the new page instead of staying on a link that
 * no longer exists. The first page load keeps the browser's default focus.
 */
export function RouteFocus() {
  const { pathname } = useLocation();
  const section = sectionOf(pathname);
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current === null || previous.current === section) {
      previous.current = section;
      return;
    }
    previous.current = section;
    // The outgoing page may still be animating out: wait for a heading that is a new element.
    const stale = document.querySelector("main h1");
    let frame = 0;
    let tries = 0;
    const tick = () => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (heading && heading !== stale) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.dataset.routeFocus = "";
        heading.focus({ preventScroll: true });
        return;
      }
      tries += 1;
      if (tries < 90) frame = window.requestAnimationFrame(tick);
      else document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [section]);

  return null;
}
