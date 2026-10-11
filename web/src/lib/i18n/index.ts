import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { resources, supportedLanguages, type Language } from "./resources";

export const LANGUAGE_STORAGE_KEY = "gouvra.lang";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    supportedLngs: [...supportedLanguages],
    nonExplicitSupportedLngs: true,
    defaultNS: "common",
    ns: Object.keys(resources.en),
    interpolation: { escapeValue: false },
    returnNull: false,
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
