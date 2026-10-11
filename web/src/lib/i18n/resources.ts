import enCommon from "@/locales/en/common.json";
import frCommon from "@/locales/fr/common.json";

export const supportedLanguages = ["en", "fr"] as const;
export type Language = (typeof supportedLanguages)[number];

export const resources = {
  en: { common: enCommon },
  fr: { common: frCommon },
} as const;

export const languageNames: Record<Language, string> = { en: "English", fr: "Français" };
