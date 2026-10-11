import { MailCheck, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "@/lib/api/errors";
import { useCountdown } from "@/lib/use-countdown";
import { fadeUp } from "@/components/motion/presets";
import { Button } from "@/components/ui/button";
import { FormProblemAlert } from "./form-alerts";

const COOLDOWN_SECONDS = 60;

/**
 * "Send the link again", with a cooldown so nobody hammers the inbox (the API also rate-limits).
 * The confirmation stays neutral: it never says whether the address has an account.
 */
export function ResendButton({
  onResend,
  variant = "secondary",
}: {
  onResend: () => Promise<unknown>;
  variant?: "secondary" | "tertiary";
}) {
  const { t } = useTranslation("auth");
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const remaining = useCountdown(retryAt);

  const resend = async () => {
    setPending(true);
    setError(null);
    try {
      await onResend();
      setSent(true);
      setRetryAt(Date.now() + COOLDOWN_SECONDS * 1000);
    } catch (caught) {
      if (isApiError(caught) && caught.isRateLimited) {
        setRetryAt(Date.now() + (caught.retryAfterSeconds ?? COOLDOWN_SECONDS) * 1000);
      } else {
        setError(caught);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant={variant}
        size="lg"
        className="w-full"
        loading={pending}
        disabled={remaining > 0}
        leftIcon={<RotateCw aria-hidden />}
        onClick={() => void resend()}
      >
        {pending ? (
          t("resend.sending")
        ) : remaining > 0 ? (
          <span className="tabular-nums">{t("resend.cooldown", { seconds: remaining })}</span>
        ) : (
          t("resend.action")
        )}
      </Button>
      <div role="status">
        <AnimatePresence initial={false}>
          {sent ? (
            <motion.p
              key="sent"
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              className="flex items-start gap-2 text-[13px] text-success-text"
            >
              <MailCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t("resend.done")}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
      {error ? <FormProblemAlert error={error} /> : null}
    </div>
  );
}
