import enAccount from "@/locales/en/account.json";
import enAuth from "@/locales/en/auth.json";
import enCommon from "@/locales/en/common.json";
import enOnboarding from "@/locales/en/onboarding.json";
import enSettings from "@/locales/en/settings.json";
import enShell from "@/locales/en/shell.json";
import frAccount from "@/locales/fr/account.json";
import frAuth from "@/locales/fr/auth.json";
import frCommon from "@/locales/fr/common.json";
import frOnboarding from "@/locales/fr/onboarding.json";
import frSettings from "@/locales/fr/settings.json";
import frShell from "@/locales/fr/shell.json";

export const supportedLanguages = ["en", "fr"] as const;
export type Language = (typeof supportedLanguages)[number];

/** One namespace per area; every key exists in both languages (see i18n.test.ts). */
export const resources = {
  en: {
    common: enCommon,
    shell: enShell,
    auth: enAuth,
    onboarding: enOnboarding,
    account: enAccount,
    settings: enSettings,
  },
  fr: {
    common: frCommon,
    shell: frShell,
    auth: frAuth,
    onboarding: frOnboarding,
    account: frAccount,
    settings: frSettings,
  },
} as const;

export const languageNames: Record<Language, string> = { en: "English", fr: "Français" };
