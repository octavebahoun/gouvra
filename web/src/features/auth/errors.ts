import type { TFunction } from "i18next";
import { useCallback, useState } from "react";
import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { isApiError, isNetworkError, type FieldError } from "@/lib/api/errors";
import { useCountdown } from "@/lib/use-countdown";

/** Password policy codes from the API (422 `validation_failed`, D-067). */
export function passwordErrorMessage(code: string, t: TFunction<"auth">): string {
  switch (code) {
    case "too_short":
      return t("password.errors.too_short");
    case "too_long":
      return t("password.errors.too_long");
    case "too_common":
      return t("password.errors.too_common");
    case "contains_email":
      return t("password.errors.contains_email");
    case "blank":
      return t("password.errors.blank");
    default:
      return t("password.errors.invalid");
  }
}

/**
 * Put the API's field errors next to their fields and focus the first one.
 * `describe` maps each server error to a form field and a translated message (or null to skip).
 * Returns true when at least one error was placed on a field.
 */
export function applyFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  describe: (fieldError: FieldError) => { field: Path<T>; message: string } | null,
): boolean {
  if (!isApiError(error) || error.fieldErrors.length === 0) return false;
  const seen = new Set<string>();
  let first = true;
  for (const fieldError of error.fieldErrors) {
    const mapped = describe(fieldError);
    if (!mapped || seen.has(mapped.field)) continue;
    seen.add(mapped.field);
    setError(mapped.field, { type: "server", message: mapped.message }, { shouldFocus: first });
    first = false;
  }
  return seen.size > 0;
}

/** Form-level message for an error that isn't tied to a field. */
export type FormProblem =
  | { kind: "network" }
  | { kind: "csrf" }
  | { kind: "server"; requestId: string | null }
  | { kind: "message"; message: string; requestId: string | null };

export function describeProblem(error: unknown, t: TFunction<"auth">): FormProblem {
  if (isNetworkError(error)) return { kind: "network" };
  if (isApiError(error)) {
    if (error.code === "csrf_failed") return { kind: "csrf" };
    if (error.code === "signup_disabled") {
      return { kind: "message", message: t("errors.signupDisabled"), requestId: null };
    }
    return { kind: "server", requestId: error.requestId };
  }
  return { kind: "server", requestId: null };
}

/**
 * 429 handling: remembers when the API allows the next attempt and counts down to it.
 * `capture(error)` returns true when the error was a rate limit.
 */
export function useRetryAfter() {
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [initialSeconds, setInitialSeconds] = useState(0);
  const remaining = useCountdown(retryAt);
  const capture = useCallback((error: unknown): boolean => {
    if (!isApiError(error) || !error.isRateLimited) return false;
    const seconds = Math.max(1, error.retryAfterSeconds ?? 30);
    setInitialSeconds(seconds);
    setRetryAt(Date.now() + seconds * 1000);
    return true;
  }, []);
  const reset = useCallback(() => setRetryAt(null), []);
  return {
    remaining,
    initialSeconds,
    blocked: remaining > 0,
    /** The limit was hit and has now expired (show "you can try again"). */
    over: retryAt !== null && remaining === 0,
    capture,
    reset,
  };
}
