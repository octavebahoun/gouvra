import enAccount from "@/locales/en/account.json";
import enAgents from "@/locales/en/agents.json";
import enAuth from "@/locales/en/auth.json";
import enCommon from "@/locales/en/common.json";
import enExecutions from "@/locales/en/executions.json";
import enOnboarding from "@/locales/en/onboarding.json";
import enProviders from "@/locales/en/providers.json";
import enSettings from "@/locales/en/settings.json";
import enShell from "@/locales/en/shell.json";
import enTools from "@/locales/en/tools.json";
import enUsage from "@/locales/en/usage.json";
import frAccount from "@/locales/fr/account.json";
import frAgents from "@/locales/fr/agents.json";
import frAuth from "@/locales/fr/auth.json";
import frCommon from "@/locales/fr/common.json";
import frExecutions from "@/locales/fr/executions.json";
import frOnboarding from "@/locales/fr/onboarding.json";
import frProviders from "@/locales/fr/providers.json";
import frSettings from "@/locales/fr/settings.json";
import frShell from "@/locales/fr/shell.json";
import frTools from "@/locales/fr/tools.json";
import frUsage from "@/locales/fr/usage.json";

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
    providers: enProviders,
    executions: enExecutions,
    tools: enTools,
    agents: enAgents,
    usage: enUsage,
  },
  fr: {
    common: frCommon,
    shell: frShell,
    auth: frAuth,
    onboarding: frOnboarding,
    account: frAccount,
    settings: frSettings,
    providers: frProviders,
    executions: frExecutions,
    tools: frTools,
    agents: frAgents,
    usage: frUsage,
  },
} as const;

export const languageNames: Record<Language, string> = { en: "English", fr: "Français" };
