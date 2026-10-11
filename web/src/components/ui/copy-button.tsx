import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { spring } from "@/components/motion/presets";

type CopyButtonProps = {
  value: string;
  /** What is being copied, for the accessible name ("Copy execution ID"). */
  label: string;
  className?: string;
  size?: "xs" | "sm";
  showText?: boolean;
};

/** Copy to clipboard with a non-intrusive confirmation: icon morph + polite announcement. */
export function CopyButton({
  value,
  label,
  className,
  size = "sm",
  showText = false,
}: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // clipboard denied (insecure context or permissions): the value stays selectable
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={t("a11y.copyValue", { label })}
      title={t("a11y.copyValue", { label })}
      className={cn(
        "relative inline-flex shrink-0 items-center gap-1 rounded-field text-muted transition-colors hover:bg-surface-2 hover:text-ink",
        size === "xs" ? "h-6 px-1 [&_svg]:size-3" : "h-7 px-1.5 [&_svg]:size-3.5",
        copied && "text-success-text hover:text-success-text",
        className,
      )}
    >
      <span className="relative inline-flex">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "check" : "copy"}
            initial={{ scale: 0.3, opacity: 0, rotate: copied ? -45 : 45 }}
            animate={{ scale: 1, opacity: 1, rotate: 0, transition: spring.snappy }}
            exit={{ scale: 0.3, opacity: 0, transition: { duration: 0.08 } }}
            className="inline-flex"
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </motion.span>
        </AnimatePresence>
      </span>
      {showText ? (
        <span className="text-xs">{copied ? t("actions.copied") : t("actions.copy")}</span>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {copied ? t("actions.copied") : ""}
      </span>
    </button>
  );
}

/**
 * Monospace identifier, shortened for display, copyable in full. Time-ordered ids (request ids)
 * share their beginning, so they read better from the end.
 */
export function IdChip({
  id,
  label,
  chars = 8,
  from = "start",
}: {
  id: string;
  label: string;
  chars?: number;
  from?: "start" | "end";
}) {
  const shown =
    id.length <= chars ? id : from === "end" ? `…${id.slice(-chars)}` : id.slice(0, chars);
  return (
    <span className="inline-flex items-center gap-0.5 rounded-field bg-surface-2 pl-2 font-mono text-xs text-muted">
      <span title={id}>{shown}</span>
      <CopyButton value={id} label={label} size="xs" />
    </span>
  );
}
