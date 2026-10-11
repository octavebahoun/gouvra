import { Check, Dot, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { spring } from "@/components/motion/presets";
import { containsEmail, PASSWORD_MAX, PASSWORD_MIN } from "../password-policy";

type RuleState = "met" | "failed" | "neutral";

/**
 * Password policy shown up front (D-067). Length and e-mail reuse are checked live; "common
 * password" is only known by the server, so it turns red only when the API refuses it.
 */
export function PasswordRequirements({
  value,
  email,
  serverCodes = [],
  invalid = false,
}: {
  value: string;
  /** The account's address, when known on this screen. */
  email?: string;
  /** Codes returned by the API for the last attempt (too_common, contains_email…). */
  serverCodes?: string[];
  /** The field currently shows an error: unmet rules are shown as failed, not pending. */
  invalid?: boolean;
}) {
  const { t } = useTranslation("auth");
  const lengthOk = value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
  const rules: { key: "length" | "common" | "email"; state: RuleState }[] = [
    {
      key: "length",
      state: lengthOk ? "met" : value.length > PASSWORD_MAX || invalid ? "failed" : "neutral",
    },
    { key: "common", state: serverCodes.includes("too_common") ? "failed" : "neutral" },
  ];
  if (email !== undefined) {
    const reused = containsEmail(value, email);
    rules.push({
      key: "email",
      state: reused ? "failed" : value.length > 0 && email.includes("@") ? "met" : "neutral",
    });
  } else {
    rules.push({
      key: "email",
      state: serverCodes.includes("contains_email") ? "failed" : "neutral",
    });
  }

  return (
    <ul aria-label={t("password.requirementsLabel")} className="mt-0.5 space-y-1">
      {rules.map(({ key, state }) => (
        <li
          key={key}
          className={cn(
            "flex items-center gap-2 text-[13px] transition-colors",
            state === "met" && "text-success-text",
            state === "failed" && "text-danger-text",
            state === "neutral" && "text-muted",
          )}
        >
          <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state}
                className="inline-flex"
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1, transition: spring.snappy }}
                exit={{ scale: 0.3, opacity: 0, transition: { duration: 0.08 } }}
              >
                {state === "met" ? (
                  <Check aria-hidden className="size-3.5" strokeWidth={2.5} />
                ) : state === "failed" ? (
                  <X aria-hidden className="size-3.5" strokeWidth={2.5} />
                ) : (
                  <Dot aria-hidden className="size-4" strokeWidth={4} />
                )}
              </motion.span>
            </AnimatePresence>
          </span>
          <span>
            {t(`password.rules.${key}`)}
            {state !== "neutral" ? (
              <span className="sr-only">
                {" "}
                ({state === "met" ? t("password.met") : t("password.notMet")})
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
