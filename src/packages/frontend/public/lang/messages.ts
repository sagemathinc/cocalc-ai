/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Locale } from "@cocalc/util/i18n";

export type LangMessages = Record<string, string>;

const MESSAGE_LOADERS: Record<
  Locale,
  () => Promise<{ default: LangMessages }>
> = {
  ar: () => import("./locales/ar/index.json"),
  br: () => import("./locales/br/index.json"),
  de: () => import("./locales/de/index.json"),
  en: () => import("./locales/en/index.json"),
  es: () => import("./locales/es/index.json"),
  eu: () => import("./locales/eu/index.json"),
  fr: () => import("./locales/fr/index.json"),
  he: () => import("./locales/he/index.json"),
  hi: () => import("./locales/hi/index.json"),
  hu: () => import("./locales/hu/index.json"),
  it: () => import("./locales/it/index.json"),
  ja: () => import("./locales/ja/index.json"),
  ko: () => import("./locales/ko/index.json"),
  nl: () => import("./locales/nl/index.json"),
  pl: () => import("./locales/pl/index.json"),
  pt: () => import("./locales/pt/index.json"),
  ru: () => import("./locales/ru/index.json"),
  tr: () => import("./locales/tr/index.json"),
  zh: () => import("./locales/zh/index.json"),
};

export async function loadLangMessages(locale: Locale): Promise<LangMessages> {
  return (await MESSAGE_LOADERS[locale]()).default;
}
