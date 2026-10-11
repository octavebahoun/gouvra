import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { LogoMark } from "@/components/brand/logo";
import { duration } from "@/components/motion/presets";

/**
 * Route-level loading indicator. It stays invisible for the first 250 ms so fast answers never
 * flash a spinner, and is announced politely to assistive technologies.
 */
export function PageLoader({ className, label }: { className?: string; label?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 250);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      role="status"
      className={cn("flex min-h-[60vh] flex-1 items-center justify-center", className)}
    >
      <span className="sr-only">{label ?? t("a11y.loading")}</span>
      {visible ? (
        <motion.div
          aria-hidden
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1, transition: { duration: duration.base } }}
          className="relative flex size-12 items-center justify-center"
        >
          <span className="absolute inset-0 animate-breathe rounded-[14px] bg-brand/30" />
          <LogoMark className="relative size-9" animated />
        </motion.div>
      ) : null}
    </div>
  );
}
