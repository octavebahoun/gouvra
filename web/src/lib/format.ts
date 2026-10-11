import { useMemo } from "react";
import { useTranslation } from "react-i18next";

type Unit = Intl.RelativeTimeFormatUnit;

const STEPS: [limitSeconds: number, unit: Unit, secondsPerUnit: number][] = [
  [45 * 60, "minute", 60],
  [22 * 3600, "hour", 3600],
  [26 * 86400, "day", 86400],
  [320 * 86400, "month", 30 * 86400],
  [Infinity, "year", 365 * 86400],
];

/** "3 minutes ago", "in 6 days", "just now" — in the interface language. */
export function formatRelative(
  date: Date | string,
  locale: string,
  justNow: string,
  now: number = Date.now(),
): string {
  const value = typeof date === "string" ? new Date(date) : date;
  const seconds = (value.getTime() - now) / 1000;
  if (Math.abs(seconds) < 45) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [limit, unit, perUnit] of STEPS) {
    if (Math.abs(seconds) < limit) return rtf.format(Math.round(seconds / perUnit), unit);
  }
  return rtf.format(Math.round(seconds / (365 * 86400)), "year");
}

/** Date formatters bound to the current interface language. */
export function useFormatters() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  return useMemo(() => {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    return {
      locale,
      date: (value: string | Date) => date.format(new Date(value)),
      dateTime: (value: string | Date) => dateTime.format(new Date(value)),
      relative: (value: string | Date) => formatRelative(value, locale, t("time.justNow")),
    };
  }, [locale, t]);
}
