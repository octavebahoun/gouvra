import createClient, { type Middleware } from "openapi-fetch";
import { ApiError, NetworkError, toProblem } from "./errors";
import { readCsrfToken } from "./http";
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

async function networkAwareFetch(input: Request): Promise<Response> {
  try {
    return await fetch(input);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new NetworkError(error);
  }
}

/** Typed client generated from the OpenAPI contract: paths, params and payloads are checked. */
export const client = createClient<paths>({
  baseUrl: "",
  credentials: "same-origin",
  fetch: networkAwareFetch,
});
client.use(csrfMiddleware);

type Result<T> = { data?: T; error?: unknown; response: Response };

/** Return the data of an openapi-fetch result, or throw a normalised ApiError. */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await promise;
  if (error !== undefined || !response.ok) {
    throw new ApiError(toProblem(response.status, error));
  }
  return data as T;
}
