/*
 *  This file is part of CoCalc: Copyright © 2024 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { defineMessage } from "react-intl";

import { IntlMessage } from "./types";
import type { Locale } from "./locale";

export { DEFAULT_LOCALE, isLocale, LOCALE } from "./locale";
export type { Locale } from "./locale";

// user's browser is not english, but user wants to keep english
// this is only for the account's other_settings and maps to "en"
export const KEEP_EN_LOCALE = "en-keep";

export const OTHER_SETTINGS_LOCALE_KEY = "i18n";

export const OTHER_SETTINGS_AI_REPLY_ENGLISH_KEY = "ai_reply_english";

// The ordering is a bit "opinionated". The top languages are European ones, and German has the best quality translations.
// Then come other European languges, kind of alphabetical.

// Then, the Asian group starts with Chinese, as the largest group.
export const LOCALIZATIONS: {
  [key in Locale]: {
    name: string;
    flag: string;
    native: string;
    trans: IntlMessage;
  };
} = {
  en: {
    name: "English",
    flag: "🇺🇸",
    native: "English",
    trans: defineMessage({
      id: "i18n.localization.lang.english",
      defaultMessage: "English",
      description:
        "The word for the langauge 'English', keep it as English but in the given target language.",
    }),
  },
  de: {
    name: "German",
    flag: "🇩🇪",
    native: "Deutsch",
    trans: defineMessage({
      id: "i18n.localization.lang.german",
      defaultMessage: "German",
    }),
  },
  es: {
    name: "Spanish",
    flag: "🇪🇸",
    native: "Español",
    trans: defineMessage({
      id: "i18n.localization.lang.spanish",
      defaultMessage: "Spanish",
    }),
  },
  eu: {
    name: "Basque",
    flag: "🏴󠁥󠁳󠁰󠁶󠁿",
    native: "Euskara",
    trans: defineMessage({
      id: "i18n.localization.lang.basque",
      defaultMessage: "Basque",
    }),
  },
  fr: {
    name: "French",
    flag: "🇫🇷",
    native: "Français",
    trans: defineMessage({
      id: "i18n.localization.lang.french",
      defaultMessage: "French",
    }),
  },
  it: {
    name: "Italian",
    flag: "🇮🇹",
    native: "Italiano",
    trans: defineMessage({
      id: "i18n.localization.lang.italian",
      defaultMessage: "Italian",
    }),
  },
  nl: {
    name: "Dutch",
    flag: "🇳🇱",
    native: "Nederlands",
    trans: defineMessage({
      id: "i18n.localization.lang.dutch",
      defaultMessage: "Dutch",
    }),
  },
  pl: {
    name: "Polish",
    flag: "🇵🇱",
    native: "Polski",
    trans: defineMessage({
      id: "i18n.localization.lang.polish",
      defaultMessage: "Polish",
    }),
  },
  hu: {
    name: "Hungarian",
    flag: "🇭🇺",
    native: "Magyar",
    trans: defineMessage({
      id: "i18n.localization.lang.hungarian",
      defaultMessage: "Hungarian",
    }),
  },
  ar: {
    name: "Arabic",
    flag: "🇪🇬",
    native: "العربية",
    trans: defineMessage({
      id: "i18n.localization.lang.arabic",
      defaultMessage: "Arabic",
    }),
  },
  br: {
    name: "Portuguese (Br)",
    flag: "🇧🇷",
    native: "Português (Br)",
    trans: defineMessage({
      id: "i18n.localization.lang.portuguese.br",
      defaultMessage: "Portuguese (Br)",
      description:
        "International Portuguese, Brazil. Keep the 'Br' abbrivation.",
    }),
  },
  pt: {
    name: "Portuguese (EU)",
    flag: "🇵🇹",
    native: "Português (EU)",
    trans: defineMessage({
      id: "i18n.localization.lang.portuguese.pt",
      defaultMessage: "Portuguese (EU)",
      description: "European Portuguese, Portugal.",
    }),
  },
  tr: {
    name: "Turkish",
    flag: "🇹🇷",
    native: "Türkçe",
    trans: defineMessage({
      id: "i18n.localization.lang.turkish",
      defaultMessage: "Turkish",
    }),
  },
  he: {
    name: "Hebrew",
    flag: "🇮🇱",
    native: "עִבְרִית",
    trans: defineMessage({
      id: "i18n.localization.lang.hebrew",
      defaultMessage: "Hebrew",
    }),
  },
  zh: {
    name: "Chinese",
    flag: "🇨🇳",
    native: "中文",
    trans: defineMessage({
      id: "i18n.localization.lang.chinese",
      defaultMessage: "Chinese",
    }),
  },
  ja: {
    name: "Japanese",
    flag: "🇯🇵",
    native: "日本語",
    trans: defineMessage({
      id: "i18n.localization.lang.japanese",
      defaultMessage: "Japanese",
    }),
  },
  hi: {
    name: "Hindi",
    flag: "🇮🇳",
    native: "हिन्दी",
    trans: defineMessage({
      id: "i18n.localization.lang.hindi",
      defaultMessage: "Hindi",
    }),
  },
  ko: {
    name: "Korean",
    flag: "🇰🇷",
    native: "한국어",
    trans: defineMessage({
      id: "i18n.localization.lang.korean",
      defaultMessage: "Korean",
    }),
  },
  ru: {
    name: "Russian",
    flag: "🇷🇺",
    native: "Русский",
    trans: defineMessage({
      id: "i18n.localization.lang.russian",
      defaultMessage: "Russian",
    }),
  },
} as const;
