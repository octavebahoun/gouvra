import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { fadeUp } from "@/components/motion/presets";

type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, { box: string; Icon: typeof Info }> = {
  info: {
    box: "border-brand/25 bg-brand-soft text-ink [&_[data-icon]]:text-brand-text",
    Icon: Info,
  },
  success: {
    box: "border-success/30 bg-success-soft text-ink [&_[data-icon]]:text-success-text",
    Icon: CircleCheck,
  },
  warning: {
    box: "border-warning/35 bg-warning-soft text-ink [&_[data-icon]]:text-warning-text",
    Icon: TriangleAlert,
  },
  danger: {
    box: "border-danger/30 bg-danger-soft text-ink [&_[data-icon]]:text-danger-text",
    Icon: CircleAlert,
  },
};

type AlertProps = {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** "alert" interrupts screen readers; use it only for errors the user must act on. */
  role?: "alert" | "status" | "note";
};

export function Alert({ tone = "info", title, children, action, className, role }: AlertProps) {
  const { box, Icon } = TONES[tone];
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn("flex gap-3 rounded-card border px-4 py-3 text-sm", box, className)}
    >
      <Icon data-icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-[13px] leading-relaxed text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </motion.div>
  );
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-card border border-line bg-surface shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 border-b border-line px-5 py-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("relative overflow-hidden rounded-field bg-surface-2", className)}
      {...props}
    >
      <div className="absolute inset-0 animate-shimmer bg-linear-to-r from-transparent via-surface/70 to-transparent" />
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-[11px] text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
