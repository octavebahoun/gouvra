import { ApiError, NetworkError, toProblem } from "./errors";

export const API_BASE = "/api/v1";
/**
 * The API names its cookies `__Host-gv_*` when they are `Secure` (production and the local
 * Docker stack) and `gv_*` otherwise (plain-HTTP development).
 */
const CSRF_COOKIES = ["__Host-gv_csrf", "gv_csrf"] as const;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readCsrfToken(): string | null {
  const parts = document.cookie.split("; ");
  for (const name of CSRF_COOKIES) {
    const match = parts.find((part) => part.startsWith(`${name}=`));
    if (match) return decodeURIComponent(match.slice(name.length + 1));
  }
  return null;
}

/**
 * Listeners notified when a signed-in request answers 401 `unauthorized` (session expired or
 * revoked). Wrong credentials (`invalid_credentials`) and the session probe itself never count.
 */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Listeners notified on 403 `email_not_verified`: the session must be refreshed. */
const unverifiedListeners = new Set<() => void>();
export function onEmailNotVerified(listener: () => void): () => void {
  unverifiedListeners.add(listener);
  return () => unverifiedListeners.delete(listener);
}

/** `/auth/*` answers describe the sign-in attempt itself, not an expired session. */
function isAuthEndpoint(url: string): boolean {
  return new URL(url, window.location.origin).pathname.startsWith(`${API_BASE}/auth/`);
}

/** Inspect an API error response and notify the session layer when it concerns the session. */
export function reportAuthProblem(url: string, status: number, code: string | undefined): void {
  if (status === 401 && code === "unauthorized" && !isAuthEndpoint(url)) {
    unauthorizedListeners.forEach((listener) => {
      listener();
    });
  } else if (status === 403 && code === "email_not_verified") {
    unverifiedListeners.forEach((listener) => {
      listener();
    });
  }
}

/** Track API reachability for the global "API unavailable" banner. */
export type Reachability = "ok" | "down";
let reachability: Reachability = "ok";
const reachabilityListeners = new Set<() => void>();
export function setReachability(next: Reachability): void {
  if (next !== reachability) {
    reachability = next;
    reachabilityListeners.forEach((listener) => {
      listener();
    });
  }
}
export function getReachability(): Reachability {
  return reachability;
}
export function subscribeReachability(listener: () => void): () => void {
  reachabilityListeners.add(listener);
  return () => reachabilityListeners.delete(listener);
}

/** A gateway error means the API behind the proxy is down; any other answer means it is up. */
export function reportStatus(status: number): void {
  setReachability(status === 502 || status === 503 || status === 504 ? "down" : "ok");
}

export type RequestOptions = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined | string[]>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(API_BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
      else url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

/** Fetch wrapper: same-origin cookies, CSRF header, Problem Details → ApiError. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      body = options.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
  }
  if (UNSAFE.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const url = buildUrl(path, options.query);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    setReachability("down");
    throw new NetworkError(error);
  }

  reportStatus(response.status);

  if (response.status === 204) return undefined as T;
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const error = new ApiError(toProblem(response.status, payload));
    reportAuthProblem(url, response.status, error.code);
    throw error;
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),
  put: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "PUT", body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
};
