export type Language = "de" | "en";

type TranslationMap = Record<Language, Record<string, string>>;

import de from "./locales/de";
import en from "./locales/en";

export const translations: TranslationMap = {
  de,
  en,
};

export function getDefaultLanguage(): Language {
  if (typeof navigator !== "undefined" && navigator.language) {
    const lower = navigator.language.toLowerCase();
    if (lower.startsWith("de")) {
      return "de";
    }
  }
  return "en";
}

export function t(lang: Language, key: string): string {
  const langTable = translations[lang] ?? translations.en;
  return (langTable && langTable[key]) || translations.en[key] || key;
}