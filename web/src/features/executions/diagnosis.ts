import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export type Diagnosis = { code: string; title: string; explanation: string; action: string };

/** Error codes the interface explains in plain words (see `executions:diagnosis`). */
export const EXPLAINED_CODES = [
  "provider_auth_error",
  "provider_permission_denied",
  "provider_rate_limited",
  "provider_quota_exhausted",
  "provider_unavailable",
  "provider_timeout",
  "provider_network_error",
  "provider_bad_request",
  "model_not_found",
  "context_length_exceeded",
  "content_filtered",
  "provider_invalid_response",
  "provider_misconfigured",
  "provider_missing",
  "agent_version_missing",
  "limit_exceeded",
  "model_refused",
  "output_truncated",
  "timeout",
  "worker_lost",
  "worker_shutdown",
  "cancelled",
  "internal_error",
] as const;
type ExplainedCode = (typeof EXPLAINED_CODES)[number];

const isExplained = (code: string): code is ExplainedCode =>
  (EXPLAINED_CODES as readonly string[]).includes(code);

const LIMITS = ["max_steps", "max_tool_calls", "max_total_tokens", "max_cost_usd"] as const;
type LimitKey = (typeof LIMITS)[number];

/**
 * Turn a normalised error code (from the gateway, the engine or the worker) into a title,
 * an explanation and the next useful action — the heart of "diagnose a failure from the UI".
 */
export function useDiagnosis() {
  const { t } = useTranslation("executions");
  return useCallback(
    (code: string, details?: Record<string, unknown> | null): Diagnosis => {
      if (!isExplained(code)) {
        return {
          code,
          title: t("diagnosis.fallback.title"),
          explanation: t("diagnosis.fallback.explanation"),
          action: t("diagnosis.fallback.action"),
        };
      }
      const rawLimit = details?.limit;
      const limit =
        typeof rawLimit === "string" && (LIMITS as readonly string[]).includes(rawLimit)
          ? t(`limits.${rawLimit as LimitKey}`)
          : "";
      return {
        code,
        title: t(`diagnosis.${code}.title`),
        explanation: t(`diagnosis.${code}.explanation`, { limit }),
        action: t(`diagnosis.${code}.action`),
      };
    },
    [t],
  );
}
