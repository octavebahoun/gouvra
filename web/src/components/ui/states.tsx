import { Lock, RotateCw, SearchX, WifiOff } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { isApiError, isNetworkError } from "@/lib/api/errors";
import { fadeUp } from "@/components/motion/presets";
import { Illustration, type IllustrationName } from "@/components/brand/illustrations";
import { Button } from "./button";
import { CopyButton } from "./copy-button";

type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  illustration?: IllustrationName;
  compact?: boolean;
  className?: string;
};

/** Explains why there is no data and offers the next useful action. */
export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  illustration = "empty",
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3 px-4 py-8" : "gap-4 px-6 py-14",
        className,
      )}
    >
      {!compact ? <Illustration name={illustration} className="h-28 w-40" /> : null}
      <div className="max-w-md space-y-1.5">
        <h2 className={cn("font-semibold text-ink", compact ? "text-sm" : "text-base")}>{title}</h2>
        {description ? (
          <p className="text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </motion.div>
  );
}

type ErrorStateProps = {
  error: unknown;
  onRetry?: () => void;
  title?: ReactNode;
  compact?: boolean;
  className?: string;
};

/** Clear message, diagnostic ID when we have one, and a retry when it is safe. */
export function ErrorState({ error, onRetry, title, compact = false, className }: ErrorStateProps) {
  const { t } = useTranslation();
  if (isApiError(error) && error.isForbidden)
    return <AccessDenied className={className} compact={compact} />;
  if (isApiError(error) && error.isNotFound)
    return <NotFoundState className={className} compact={compact} />;
  const offline = isNetworkError(error);
  const requestId = isApiError(error) ? error.requestId : null;
  const message = offline
    ? t("errors.network")
    : isApiError(error) && error.status < 500
      ? error.message
      : t("states.errorBody");
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-4 text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
        className,
      )}
    >
      {offline ? (
        <span className="flex size-12 items-center justify-center rounded-full bg-warning-soft text-warning-text">
          <WifiOff aria-hidden className="size-5" />
        </span>
      ) : (
        <Illustration name="error" className={compact ? "h-16 w-24" : "h-28 w-40"} />
      )}
      <div className="max-w-md space-y-1.5">
        <h2 className="text-base font-semibold text-ink">{title ?? t("states.errorTitle")}</h2>
        <p className="text-[13px] leading-relaxed text-muted">{message}</p>
      </div>
      {requestId ? (
        <div className="flex items-center gap-1 rounded-field bg-surface-2 py-0.5 pr-0.5 pl-2.5 text-xs text-muted">
          <span>{t("states.diagnosticId")}:</span>
          <code className="font-mono text-ink">{requestId}</code>
          <CopyButton value={requestId} label={t("states.diagnosticId")} size="xs" />
        </div>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry} leftIcon={<RotateCw aria-hidden />}>
          {t("actions.retry")}
        </Button>
      ) : null}
    </motion.div>
  );
}

export function AccessDenied({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <EmptyState
      className={className}
      compact={compact}
      illustration="locked"
      title={
        <span className="inline-flex items-center gap-2">
          {compact ? <Lock aria-hidden className="size-4 text-muted" /> : null}
          {t("states.accessDeniedTitle")}
        </span>
      }
      description={t("states.accessDeniedBody")}
    />
  );
}

export function NotFoundState({
  className,
  compact = false,
  action,
}: {
  className?: string;
  compact?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <EmptyState
      className={className}
      compact={compact}
      illustration="not-found"
      title={
        <span className="inline-flex items-center gap-2">
          {compact ? <SearchX aria-hidden className="size-4 text-muted" /> : null}
          {t("states.notFoundTitle")}
        </span>
      }
      description={t("states.notFoundBody")}
      action={action}
    />
  );
}

/** Marks a value that the source did not provide — never a misleading zero. */
export function Unavailable({ reason }: { reason?: string }) {
  const { t } = useTranslation();
  return (
    <span className="text-muted" title={reason ?? t("states.unavailable")}>
      <span aria-hidden>—</span>
      <span className="sr-only">{reason ?? t("states.unavailable")}</span>
    </span>
  );
}
