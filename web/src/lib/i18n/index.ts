import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import type { BackendModule } from "i18next";
import { loaders, namespaces, supportedLanguages, type Language } from "./resources";

export const LANGUAGE_STORAGE_KEY = "gouvra.lang";

const isLanguage = (value: string): value is Language =>
  (supportedLanguages as readonly string[]).includes(value);

/** Loads a language's namespaces from its chunk; i18next keeps the current language meanwhile. */
const lazyLanguages: BackendModule = {
  type: "backend",
  init: () => undefined,
  read(language, namespace, callback) {
    const lng = language.split("-")[0] ?? "en";
    if (!isLanguage(lng)) {
      callback(null, {});
      return;
    }
    loaders[lng]()
      .then((module) => callback(null, module.default[namespace as keyof typeof module.default]))
      .catch((error: unknown) => callback(error as Error, null));
  },
};

/** Resolves once the interface language is loaded: render the app after it (see main.tsx). */
export const i18nReady = i18n
  .use(lazyLanguages)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // A supported language needs no fallback (both are complete); anything else gets English.
    fallbackLng: (code: string) => (isLanguage(code.split("-")[0] ?? "") ? [] : ["en"]),
    supportedLngs: [...supportedLanguages],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    defaultNS: "common",
    ns: [...namespaces],
    interpolation: { escapeValue: false },
    returnNull: false,
    // Switching language keeps the current texts until the new ones have arrived.
    react: { useSuspense: false, bindI18n: "languageChanged loaded" },
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ["localStorage"],
    },
  });

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng.split("-")[0] ?? "en";
});
document.documentElement.lang = (i18n.resolvedLanguage ?? "en").split("-")[0] ?? "en";

export function currentLanguage(): Language {
  const lng = (i18n.resolvedLanguage ?? "en").split("-")[0];
  return supportedLanguages.includes(lng as Language) ? (lng as Language) : "en";
}

export default i18n;
