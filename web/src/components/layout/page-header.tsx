import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { fadeUp } from "@/components/motion/presets";

export type Crumb = { label: ReactNode; to?: string };

type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
  /** Small elements next to the title: status badge, version, ID chip... */
  meta?: ReactNode;
  className?: string;
};

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  className,
}: PageHeaderProps) {
  const { t } = useTranslation();
  return (
    <motion.header
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className={cn("flex flex-col gap-3 pb-6", className)}
    >
      {breadcrumbs?.length ? (
        <nav aria-label={t("a11y.breadcrumb")}>
          <ol className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
            {breadcrumbs.map((crumb, index) => {
              const last = index === breadcrumbs.length - 1;
              return (
                <li key={index} className="inline-flex items-center gap-1">
                  {crumb.to && !last ? (
                    <Link to={crumb.to} className="rounded-sm hover:text-ink hover:underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      aria-current={last ? "page" : undefined}
                      className={cn(last && "text-ink")}
                    >
                      {crumb.label}
                    </span>
                  )}
                  {!last ? <ChevronRight aria-hidden className="size-3.5 opacity-60" /> : null}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
            {meta}
          </div>
          {description ? (
            <p className="max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </motion.header>
  );
}

/** Centered content column with the app's horizontal rhythm. */
export function PageContainer({
  children,
  className,
  wide = false,
}: {
  children: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8",
        wide ? "max-w-[1600px]" : "max-w-6xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
