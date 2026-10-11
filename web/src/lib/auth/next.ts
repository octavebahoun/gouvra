/** Where to go after signing in: a same-origin relative path, never an open redirect. */
export const DEFAULT_AFTER_SIGN_IN = "/app";

const AUTH_PAGES = ["/login", "/register", "/forgot-password"];

export function safeNext(raw: string | null | undefined, fallback = DEFAULT_AFTER_SIGN_IN): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    if (AUTH_PAGES.some((page) => url.pathname === page || url.pathname.startsWith(`${page}/`))) {
      return fallback;
    }
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}

/** `/login?next=…` for the given location (the fragment is never carried along). */
export function loginPath(location: { pathname: string; search: string }): string {
  const next = location.pathname + location.search;
  return next === "/" || next === DEFAULT_AFTER_SIGN_IN
    ? "/login"
    : `/login?next=${encodeURIComponent(next)}`;
}

/** Keep `?next=` when moving between sign-in, sign-up and recovery pages. */
export function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
