/** Normalised API error, built from RFC 9457 Problem Details responses. */

export type FieldError = { field: string; code: string; message: string };

export type ProblemDetails = {
  type?: string;
  title?: string;
  status: number;
  code: string;
  detail?: string;
  request_id?: string | null;
  details?: Record<string, unknown>;
  errors?: FieldError[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly requestId: string | null;
  readonly details: Record<string, unknown>;
  readonly fieldErrors: FieldError[];

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title ?? problem.code);
    this.name = "ApiError";
    this.status = problem.status;
    this.code = problem.code;
    this.title = problem.title ?? problem.code;
    this.requestId = problem.request_id ?? null;
    this.details = problem.details ?? {};
    this.fieldErrors = problem.errors ?? [];
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
  get retryAfterSeconds(): number | null {
    const value = this.details.retry_after;
    return typeof value === "number" ? value : null;
  }
}

/** The request never reached the API (offline, DNS, proxy down...). */
export class NetworkError extends Error {
  constructor(cause?: unknown) {
    super("Network request failed", { cause });
    this.name = "NetworkError";
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

export function toProblem(status: number, body: unknown): ProblemDetails {
  if (body && typeof body === "object" && "code" in body && "status" in body) {
    return body as ProblemDetails;
  }
  return {
    status,
    code: status >= 500 ? "internal_error" : "http_error",
    title: `HTTP ${status}`,
  };
}
