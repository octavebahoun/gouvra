import { ArrowRight, Check, PartyPopper } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { duration, ease, listItem, spring, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/feedback";
import { ErrorState } from "@/components/ui/states";
import { useDismissOnboarding, useOnboarding, type Onboarding } from "@/features/workspaces/api";
import { stepMeta, type StepMeta } from "./checklist-steps";

type OnboardingChecklistProps = {
  workspace: { id: string; slug: string };
  /** Admins and the owner may hide the checklist (`workspace:update`). */
  canDismiss: boolean;
  /** On the overview the checklist disappears once hidden; the onboarding page always shows it. */
  hideWhenDismissed?: boolean;
  footer?: ReactNode;
  className?: string;
};

/**
 * First-configuration checklist (onboarding page and workspace overview). Designed for 2 to 6
 * steps; steps added later by the API render with their own copy, or a generic one.
 */
export function OnboardingChecklist({
  workspace,
  canDismiss,
  hideWhenDismissed = true,
  footer,
  className,
}: OnboardingChecklistProps) {
  const { t } = useTranslation(["onboarding", "common"]);
  const query = useOnboarding(workspace.id);
  const dismiss = useDismissOnboarding(workspace.id);

  if (query.isPending) return <ChecklistSkeleton className={className} />;
  if (query.isError) {
    return (
      <Card className={className}>
        <ErrorState
          compact
          title={t("checklist.loadError")}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </Card>
    );
  }

  const hidden = hideWhenDismissed && query.data.dismissed;
  const onDismiss = () =>
    dismiss.mutate(undefined, {
      onSuccess: () => toast.success(t("checklist.dismissed")),
      onError: () => toast.error(t("checklist.dismissFailed")),
    });

  return (
    <AnimatePresence initial={false}>
      {hidden ? null : (
        <motion.div
          key="checklist"
          exit={{
            opacity: 0,
            scale: 0.98,
            transition: { duration: duration.base, ease: ease.exit },
          }}
          className={className}
        >
          <ChecklistCard
            data={query.data}
            basePath={`/w/${workspace.slug}`}
            canDismiss={canDismiss && !query.data.dismissed}
            dismissing={dismiss.isPending}
            onDismiss={onDismiss}
            footer={footer}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ChecklistCard({
  data,
  basePath,
  canDismiss,
  dismissing,
  onDismiss,
  footer,
}: {
  data: Onboarding;
  basePath: string;
  canDismiss: boolean;
  dismissing: boolean;
  onDismiss: () => void;
  footer?: ReactNode;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  const complete = data.total > 0 && data.completed >= data.total;
  const progressText = t("checklist.progress", { completed: data.completed, total: data.total });

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 pt-5 pb-4">
        <span
          aria-hidden
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-card",
            complete ? "bg-success-soft text-success-text" : "bg-brand-soft text-brand-text",
          )}
        >
          {complete ? <PartyPopper className="size-5" /> : <Check className="size-5" />}
        </span>
        <div className="min-w-[12rem] flex-1">
          <h2 className="text-[15px] font-semibold text-ink">
            {complete ? t("checklist.complete") : t("checklist.title")}
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {complete ? t("checklist.completeBody") : t("checklist.subtitle")}
          </p>
        </div>
        {canDismiss ? (
          <Button
            variant="tertiary"
            size="sm"
            className="-mr-2 ml-auto max-sm:ml-12"
            loading={dismissing}
            onClick={onDismiss}
          >
            {t("checklist.dismiss")}
          </Button>
        ) : null}
      </div>

      <div className="px-5 pb-5">
        <div className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
          <span className="text-muted">{progressText}</span>
          <span aria-hidden className="font-medium text-ink tabular-nums">
            {data.completed}/{data.total}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={t("progressLabel")}
          aria-valuemin={0}
          aria-valuemax={data.total}
          aria-valuenow={data.completed}
          aria-valuetext={progressText}
          className="flex gap-1.5"
        >
          {data.steps
            .filter((step) => !step.optional)
            .map((step, index) => (
              <span
                key={step.key}
                aria-hidden
                className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
              >
                <motion.span
                  className={cn(
                    "absolute inset-0 origin-left rounded-full",
                    complete ? "bg-success" : "bg-brand",
                  )}
                  initial={{ scaleX: 0 }}
                  animate={{
                    scaleX: step.done ? 1 : 0,
                    transition: {
                      duration: duration.slow,
                      ease: ease.standard,
                      delay: 0.1 + index * 0.08,
                    },
                  }}
                />
              </span>
            ))}
        </div>
      </div>

      <motion.ol
        aria-label={t("progressLabel")}
        variants={staggerChildren(0.05, 0.05)}
        initial="hidden"
        animate="visible"
        className="divide-y divide-line border-t border-line"
      >
        {data.steps.map((step, index) => (
          <ChecklistRow
            key={step.key}
            index={index}
            done={step.done}
            optional={step.optional}
            meta={stepMeta(step.key, basePath, t)}
          />
        ))}
      </motion.ol>
      {footer ? (
        <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-surface-2/40 px-5 py-3">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

function ChecklistRow({
  index,
  done,
  optional,
  meta,
}: {
  index: number;
  done: boolean;
  optional: boolean;
  meta: StepMeta;
}) {
  const { t } = useTranslation("onboarding");
  const { Icon } = meta;
  return (
    <motion.li variants={listItem} className="flex items-start gap-4 px-5 py-4">
      <span className="relative mt-0.5 inline-flex size-7 shrink-0 items-center justify-center">
        <AnimatePresence initial={false} mode="popLayout">
          {done ? (
            <motion.span
              key="done"
              className="inline-flex size-7 items-center justify-center rounded-full bg-success text-on-solid"
              initial={{ scale: 0.4, opacity: 0, rotate: -20 }}
              animate={{ scale: 1, opacity: 1, rotate: 0, transition: spring.snappy }}
            >
              <Check aria-hidden className="size-4" strokeWidth={3} />
            </motion.span>
          ) : (
            <motion.span
              key="todo"
              exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.12 } }}
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-full border bg-surface text-muted",
                optional ? "border-dashed border-line-strong/70" : "border-line-strong/70",
              )}
            >
              <Icon aria-hidden className="size-3.5" />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium text-ink">
              <span className="sr-only">{index + 1}. </span>
              {meta.title}
            </h3>
            {optional ? <Badge tone="outline">{t("checklist.optional")}</Badge> : null}
            <span className="sr-only">
              {" — "}
              {done ? t("checklist.done") : t("checklist.todo")}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{meta.description}</p>
        </div>
        <div className="shrink-0">
          {done ? (
            <span
              aria-hidden
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-success-text"
            >
              <Check className="size-3.5" strokeWidth={2.5} />
              {t("checklist.done")}
            </span>
          ) : meta.to ? (
            <Button asChild size="sm" variant="secondary" rightIcon={<ArrowRight aria-hidden />}>
              <Link to={meta.to}>{meta.cta}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
}

function ChecklistSkeleton({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Card className={cn("overflow-hidden", className)} aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      <div className="flex items-start gap-4 px-5 pt-5 pb-4">
        <Skeleton className="size-10 rounded-card" />
        <div className="flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      </div>
      <div className="px-5 pb-5">
        <Skeleton className="mb-2 h-3 w-40" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
      <div className="divide-y divide-line border-t border-line">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-4 px-5 py-4">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="hidden h-8 w-28 sm:block" />
          </div>
        ))}
      </div>
    </Card>
  );
}
