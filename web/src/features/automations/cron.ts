import cronstrue from "cronstrue";
import "cronstrue/locales/fr";

/** Ready-made schedules (most people never write cron). */
export const CRON_PRESETS = [
  { key: "hourly", cron: "0 * * * *" },
  { key: "daily", cron: "0 9 * * *" },
  { key: "weekdays", cron: "0 9 * * 1-5" },
  { key: "weekly", cron: "0 8 * * 1" },
  { key: "monthly", cron: "0 8 1 * *" },
] as const;

/** A cron expression in words, in the interface language ("At 09:00, Monday through Friday"). */
export function describeCron(expression: string, language: string): string | null {
  try {
    return cronstrue.toString(expression, {
      locale: language.startsWith("fr") ? "fr" : "en",
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
      verbose: false,
    });
  } catch {
    return null;
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function timeZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC", "Europe/Paris", "Europe/London", "America/New_York", "Asia/Tokyo"];
  }
}
