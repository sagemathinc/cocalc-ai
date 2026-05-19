/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

interface CookieItem {
  name: string | RegExp;
}

export interface CookieCategory {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly defaultEnabled: boolean;
  readonly autoClearCookies?: ReadonlyArray<CookieItem>;
}

export const COOKIE_CATEGORIES = [
  {
    key: "necessary",
    label: "Necessary cookies",
    description:
      "Required for sign-in and to keep your session active. These cookies cannot be turned off.",
    readOnly: true,
    defaultEnabled: true,
  },
  {
    key: "analytics",
    label: "Analytics cookies",
    description:
      "Third-party analytics that help us understand how the site is used.",
    readOnly: false,
    defaultEnabled: false,
    autoClearCookies: [{ name: /^_ga/ }, { name: /^_gid/ }, { name: "CC_ANA" }],
  },
  {
    key: "usage",
    label: "Usage metrics",
    description:
      "First-party metrics recorded in our own database to help us improve the product.",
    readOnly: false,
    defaultEnabled: false,
  },
] as const satisfies ReadonlyArray<CookieCategory>;

export type CookieCategoryKey = (typeof COOKIE_CATEGORIES)[number]["key"];
