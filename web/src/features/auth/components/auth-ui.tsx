import { motion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { duration, ease, fadeUp, spring, staggerChildren } from "@/components/motion/presets";

type AuthHeadingProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Move focus to the heading when it appears after an in-page change (form → result). */
  focusOnMount?: boolean;
  className?: string;
};

/** The page's h1 and its lead paragraph. */
export function AuthHeading({ title, description, focusOnMount, className }: AuthHeadingProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  return (
    <div className={cn("space-y-2", className)}>
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-balance text-ink"
      >
        {title}
      </h1>
      {description ? (
        <p className="text-sm leading-relaxed text-pretty text-muted">{description}</p>
      ) : null}
    </div>
  );
}

/** Vertical rhythm shared by every auth screen: children enter one after another. */
export function AuthStack({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={staggerChildren(0.05)}
      initial="hidden"
      animate="visible"
      className={cn("flex flex-col gap-7", className)}
    >
      {children}
    </motion.div>
  );
}

export function AuthItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={fadeUp} className={className}>
      {children}
    </motion.div>
  );
}

type Tone = "success" | "danger" | "warning" | "info";

const TONES: Record<Tone, { badge: string; ring: string }> = {
  success: { badge: "bg-success-soft text-success-text", ring: "border-success/40" },
  danger: { badge: "bg-danger-soft text-danger-text", ring: "border-danger/40" },
  warning: { badge: "bg-warning-soft text-warning-text", ring: "border-warning/40" },
  info: { badge: "bg-brand-soft text-brand-text", ring: "border-brand/40" },
};

type StatusPanelProps = {
  tone: Tone;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Secondary information under the actions (signed-in identity, help). */
  footer?: ReactNode;
  /** Focus the heading when the panel replaces a form (the result must be heard). */
  focusOnMount?: boolean;
};

/**
 * Outcome screen (link confirmed, link expired, e-mail sent…): an icon that pops in with a
 * single ring pulse, the h1, the explanation and the next actions.
 */
export function StatusPanel({
  tone,
  icon,
  title,
  children,
  actions,
  footer,
  focusOnMount = false,
}: StatusPanelProps) {
  const { badge, ring } = TONES[tone];
  return (
    <AuthStack>
      <AuthItem>
        <div className="relative inline-flex">
          <motion.span
            aria-hidden
            className={cn("absolute inset-0 rounded-full border-2", ring)}
            initial={{ scale: 1, opacity: 0.9 }}
            animate={{
              scale: 1.7,
              opacity: 0,
              transition: { duration: 0.7, ease: ease.standard, delay: 0.15 },
            }}
          />
          <motion.span
            aria-hidden
            className={cn(
              "relative inline-flex size-12 items-center justify-center rounded-full [&_svg]:size-6",
              badge,
            )}
            initial={{ scale: 0.5, opacity: 0, rotate: -12 }}
            animate={{ scale: 1, opacity: 1, rotate: 0, transition: spring.snappy }}
          >
            {icon}
          </motion.span>
        </div>
      </AuthItem>
      <AuthItem>
        <AuthHeading title={title} focusOnMount={focusOnMount} />
        {children ? (
          <div className="mt-2 space-y-3 text-sm leading-relaxed text-pretty text-muted">
            {children}
          </div>
        ) : null}
      </AuthItem>
      {actions ? (
        <AuthItem className="flex flex-col gap-2.5 [&>*]:w-full">{actions}</AuthItem>
      ) : null}
      {footer ? (
        <AuthItem className="border-t border-line pt-5 text-[13px] leading-relaxed text-muted">
          {footer}
        </AuthItem>
      ) : null}
    </AuthStack>
  );
}

/** "New to Gouvra? Create an account" line at the bottom of a form. */
export function AuthSwitch({ prompt, to, label }: { prompt: string; to: string; label: string }) {
  return (
    <p className="text-center text-sm text-muted">
      {prompt}{" "}
      <Link
        to={to}
        className="rounded-sm font-medium text-brand-text underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    </p>
  );
}

/** Thin horizontal rule with a centred label ("or with your e-mail"). */
export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Indeterminate "working on it" header used while a link is being checked. */
export function PendingPanel({ title }: { title: string }) {
  return (
    <div role="status" className="flex flex-col items-start gap-5">
      <span className="relative inline-flex size-12 items-center justify-center rounded-full bg-brand-soft">
        <motion.span
          aria-hidden
          className="absolute inset-1 rounded-full border-2 border-brand/25 border-t-brand"
          animate={{ rotate: 360 }}
          transition={{ duration: 0.9, ease: "linear", repeat: Infinity }}
        />
      </span>
      <motion.h1
        tabIndex={-1}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: { duration: duration.base, delay: 0.2 } }}
        className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink"
      >
        {title}
      </motion.h1>
    </div>
  );
}
