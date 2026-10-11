import { cva, type VariantProps } from "class-variance-authority";
import { Ban, CircleCheck, CircleDashed, CircleX, Hourglass, LoaderCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { spring } from "@/components/motion/presets";

export const badgeVariants = cva(
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-soft text-muted",
        brand: "bg-brand-soft text-brand-text",
        success: "bg-success-soft text-success-text",
        warning: "bg-warning-soft text-warning-text",
        danger: "bg-danger-soft text-danger-text",
        outline: "border border-line text-muted",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { icon?: ReactNode };

export function Badge({ className, tone, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon}
      {children}
    </span>
  );
}

export type ExecutionStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

const STATUS: Record<
  ExecutionStatus,
  { tone: NonNullable<BadgeProps["tone"]>; Icon: typeof CircleCheck }
> = {
  queued: { tone: "neutral", Icon: CircleDashed },
  running: { tone: "brand", Icon: LoaderCircle },
  succeeded: { tone: "success", Icon: CircleCheck },
  failed: { tone: "danger", Icon: CircleX },
  cancelled: { tone: "neutral", Icon: Ban },
  timed_out: { tone: "danger", Icon: Hourglass },
};

export function isTerminal(status: ExecutionStatus): boolean {
  return status !== "queued" && status !== "running";
}

/**
 * Execution state: text + icon + colour (never colour alone). While running, a soft
 * "breathing" halo signals life; on change, the new state pops in.
 */
export function StatusBadge({
  status,
  className,
}: {
  status: ExecutionStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const { tone, Icon } = STATUS[status];
  return (
    <span
      className={cn(badgeVariants({ tone }), "relative overflow-visible", className)}
      data-status={status}
    >
      <span className="relative inline-flex size-3.5 items-center justify-center">
        {status === "running" ? (
          <span aria-hidden className="absolute inset-0 animate-breathe rounded-full bg-brand" />
        ) : null}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={status}
            initial={{ scale: 0.4, opacity: 0, rotate: -30 }}
            animate={{ scale: 1, opacity: 1, rotate: 0, transition: spring.snappy }}
            exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.1 } }}
            className="relative inline-flex"
          >
            <Icon
              aria-hidden
              className={cn("size-3.5", status === "running" && "animate-spin-slow")}
            />
          </motion.span>
        </AnimatePresence>
      </span>
      <span>{t(`status.${status}`)}</span>
    </span>
  );
}
