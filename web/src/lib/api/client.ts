import createClient, { type Middleware } from "openapi-fetch";
import { ApiError, NetworkError, toProblem } from "./errors";
import { readCsrfToken, reportAuthProblem, reportStatus, setReachability } from "./http";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (UNSAFE.has(request.method)) {
      const token = readCsrfToken();
      if (token) request.headers.set("X-CSRF-Token", token);
    }
    return request;
  },
};

/**
 * Feeds the session layer and the "API unavailable" banner from every typed call:
 * 401 `unauthorized` → session expired, 403 `email_not_verified` → refresh the session,
 * 502/503/504 → API down.
 */
const sessionMiddleware: Middleware = {
  async onResponse({ request, response }) {
    reportStatus(response.status);
    if (response.status === 401 || response.status === 403) {
      const body: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      const code =
        body && typeof body === "object" && "code" in body && typeof body.code === "string"
          ? body.code
          : undefined;
      reportAuthProblem(request.url, response.status, code);
    }
    return response;
  },
};

async function networkAwareFetch(input: Request): Promise<Response> {
  try {
    return await fetch(input);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    setReachability("down");
    throw new NetworkError(error);
  }
}

/** Typed client generated from the OpenAPI contract: paths, params and payloads are checked. */
export const client = createClient<paths>({
  // Absolute same-origin URLs: identical in browsers, and resolvable outside them (tests).
  baseUrl: typeof window === "undefined" ? "" : window.location.origin,
  credentials: "same-origin",
  fetch: networkAwareFetch,
});
client.use(csrfMiddleware, sessionMiddleware);

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Return the data of an openapi-fetch result, or throw a normalised ApiError. */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (error !== undefined || !response.ok) {
    throw new ApiError(toProblem(response.status, error));
  }
  return data as T;
}
