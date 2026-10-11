import { ApiError, NetworkError, toProblem } from "./errors";

export const API_BASE = "/api/v1";
const CSRF_COOKIE = "gv_csrf";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readCsrfToken(): string | null {
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : null;
}

/** Listeners notified when the API answers 401 (session expired) — the auth layer redirects. */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Track API reachability for the global "API unavailable" banner. */
type Reachability = "ok" | "down";
let reachability: Reachability = "ok";
const reachabilityListeners = new Set<() => void>();
function setReachability(next: Reachability): void {
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

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
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

  if (response.status === 502 || response.status === 503 || response.status === 504) {
    setReachability("down");
  } else {
    setReachability("ok");
  }

  if (response.status === 204) return undefined as T;
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  const payload: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const error = new ApiError(toProblem(response.status, payload));
    if (response.status === 401) {
      unauthorizedListeners.forEach((listener) => {
        listener();
      });
    }
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
