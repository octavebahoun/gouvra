import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { fadeUp } from "@/components/motion/presets";

/**
 * Settings row: what the section is about on the left (desktop), its controls on the right.
 * Stacks on tablet and mobile.
 */
export function SettingsSection({
  id,
  title,
  description,
  children,
  tone = "default",
  className,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger";
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <motion.section
      id={id}
      variants={fadeUp}
      aria-labelledby={headingId}
      className={cn("grid gap-x-10 gap-y-4 lg:grid-cols-[15rem_minmax(0,1fr)]", className)}
    >
      <div className="lg:pt-1">
        <h2
          id={headingId}
          className={cn(
            "text-[15px] font-semibold",
            tone === "danger" ? "text-danger-text" : "text-ink",
          )}
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-pretty text-muted">{description}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </motion.section>
  );
}
