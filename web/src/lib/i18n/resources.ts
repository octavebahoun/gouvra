import type en from "@/locales/en";

export const supportedLanguages = ["en", "fr"] as const;
export type Language = (typeof supportedLanguages)[number];

/** One namespace per area; every key exists in both languages (see i18n.test.ts). */
export type Resources = typeof en;

/** Each language is a separate chunk, fetched only when it is used. */
export const loaders: Record<Language, () => Promise<{ default: Resources }>> = {
  en: () => import("@/locales/en"),
  fr: () => import("@/locales/fr"),
};

export const namespaces = [
  "common",
  "shell",
  "auth",
  "onboarding",
  "account",
  "settings",
  "providers",
  "executions",
  "tools",
  "agents",
  "usage",
  "site",
  "evaluations",
  "workflows",
] as const satisfies readonly (keyof Resources)[];

export const languageNames: Record<Language, string> = { en: "English", fr: "Français" };
