/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { LOCALE, type Locale } from "@cocalc/util/i18n";

const LOCALES = new Set<string>(LOCALE);

export type PublicLangRoute =
  | { view: "index" }
  | { locale: Locale; view: "locale" };

function getRouteParts(pathname: string): string[] {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  const baseOffset =
    appBasePath === "/" ? 0 : appBasePath.split("/").filter(Boolean).length;
  return parts.slice(baseOffset);
}

function parseLocale(value?: string): Locale | undefined {
  if (!value || !LOCALES.has(value)) return;
  return value as Locale;
}

export function parsePublicLangTarget(
  pathname?: string | null,
): PublicLangRoute | undefined {
  if (!pathname) return;
  const routeParts = getRouteParts(pathname);
  if (routeParts.length === 0) return;
  if (routeParts[0] === "lang") {
    if (routeParts.length === 1) return { view: "index" };
    const locale = parseLocale(routeParts[1]);
    if (locale && routeParts.length === 2) {
      return { locale, view: "locale" };
    }
    return;
  }
  const locale = parseLocale(routeParts[0]);
  if (locale && routeParts.length === 1) {
    return { locale, view: "locale" };
  }
}

export function getLangRouteFromPath(pathname: string): PublicLangRoute {
  return parsePublicLangTarget(pathname) ?? { view: "index" };
}

export function langPath(locale?: Locale): string {
  const base = appBasePath === "/" ? "" : appBasePath;
  return locale ? `${base}/${locale}` : `${base}/lang`;
}
