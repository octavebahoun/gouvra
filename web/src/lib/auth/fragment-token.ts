/**
 * One-time tokens from e-mail links travel in the URL fragment (`/verify-email#token=…`), so they
 * never reach a server log or a Referer header (D-064). The fragment is read once when the app
 * boots — e-mail links always open a fresh page — and removed from the address bar before the
 * router even sees it, so it is not kept in history, bookmarks or screenshots.
 */
type Captured = { pathname: string; token: string };

let captured: Captured | null = null;

function normalise(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function captureFragmentToken(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (!token) return;
  captured = { pathname: normalise(window.location.pathname), token };
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

/** The token captured for this page, if the app was opened from an e-mail link to it. */
export function getFragmentToken(pathname: string): string | null {
  return captured?.pathname === normalise(pathname) ? captured.token : null;
}

/** Forget the token once its page has used it (a later visit must not replay it). */
export function clearFragmentToken(): void {
  captured = null;
}

/** Test helper. */
export function setFragmentTokenForTests(pathname: string, token: string | null): void {
  captured = token ? { pathname, token } : null;
}
