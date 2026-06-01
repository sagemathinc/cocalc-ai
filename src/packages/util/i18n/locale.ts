/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// ATTN: these languages have to match the frontend/package.json script "i18n:download",
//       be valid for Antd (<AntdConfigProvider localize.../>),
//       and also harmonize with localize::loadLocaleData
//       They also have to match next.js, which is on-par with the languages.
export const LOCALE = [
  "en", // that's the default, i.e. user never explicitly selected a language
  "es",
  "de",
  "zh",
  "ru",
  "fr",
  "it",
  "nl",
  "ja",
  "hi",
  "pt", // european portuguese [pt_PT]
  "ko",
  "pl",
  "tr",
  "he",
  "hu",
  "ar",
  "br", // brazilian portuguese [pt_BR]
  "eu", // Basque [eu] (fallback: Catalan, Spanish)
] as const;

export type Locale = (typeof LOCALE)[number];

export function isLocale(val: unknown): val is Locale {
  if (typeof val !== "string") return false;
  return LOCALE.includes(val as any);
}

export const DEFAULT_LOCALE: Locale = "en";
