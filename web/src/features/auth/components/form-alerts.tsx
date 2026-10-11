import { RotateCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Alert } from "@/components/ui/feedback";
import { FormError } from "@/components/ui/field";
import { useAnnounce } from "@/components/ui/live-region";
import { describeProblem } from "../errors";

/** Form-level error that isn't tied to a field: network, stale page, server failure. */
export function FormProblemAlert({ error }: { error: unknown }) {
  const { t } = useTranslation("auth");
  const problem = describeProblem(error, t);
  if (problem.kind === "network") return <FormError>{t("errors.network")}</FormError>;
  if (problem.kind === "csrf") {
    return (
      <FormError>
        <p>{t("errors.csrf")}</p>
        <Button
          variant="link"
          size="sm"
          className="mt-1 text-danger-text"
          leftIcon={<RotateCw aria-hidden />}
          onClick={() => window.location.reload()}
        >
          {t("errors.reload")}
        </Button>
      </FormError>
    );
  }
  const message = problem.kind === "message" ? problem.message : t("errors.server");
  return (
    <FormError>
      <p>{message}</p>
      {problem.requestId ? (
        <p className="mt-1 flex items-center gap-1 text-xs">
          <span>{t("errors.diagnostic", { id: problem.requestId })}</span>
          <CopyButton
            value={problem.requestId}
            label={t("errors.diagnostic", { id: "" })}
            size="xs"
          />
        </p>
      ) : null}
    </FormError>
  );
}

/**
 * 429 notice with a live countdown. The ticking number is hidden from assistive technologies
 * (it would be re-read every second); they hear one sentence when it appears, and another when
 * the wait is over.
 */
export function RateLimitAlert({
  remaining,
  initialSeconds,
  over,
}: {
  remaining: number;
  initialSeconds: number;
  over: boolean;
}) {
  const { t } = useTranslation("auth");
  const announce = useAnnounce();
  const announcedOver = useRef(false);
  useEffect(() => {
    if (over && !announcedOver.current) {
      announcedOver.current = true;
      announce(t("errors.rateLimitedOver"));
    }
    if (!over) announcedOver.current = false;
  }, [over, announce, t]);

  if (over || remaining <= 0) return null;
  return (
    <Alert
      tone="warning"
      title={
        <>
          <span aria-hidden className="tabular-nums">
            {t("errors.rateLimited", { seconds: remaining })}
          </span>
          <span className="sr-only">{t("errors.rateLimited", { seconds: initialSeconds })}</span>
        </>
      }
    />
  );
}
