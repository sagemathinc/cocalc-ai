/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Translation } from "vanilla-cookieconsent";

import { COOKIE_CATEGORIES } from "./categories";

export function buildTranslation(
  descHtml: string,
  privacyUrl: string,
  termsUrl: string,
): Translation {
  const footerLinks = `<a href="${privacyUrl}" target="_blank" rel="noopener noreferrer">Privacy policy</a>\n<a href="${termsUrl}" target="_blank" rel="noopener noreferrer">Terms of service</a>`;
  const prefsLead = `${descHtml}\n<p style="margin-top: 0.75em; font-size: 0.9em;">${footerLinks.replace("\n", " · ")}</p>`;
  const categorySections = COOKIE_CATEGORIES.map((category) => ({
    title: category.label,
    description: category.description,
    linkedCategory: category.key,
  }));

  return {
    consentModal: {
      title: "We value your privacy",
      description: descHtml,
      acceptAllBtn: "Accept all",
      acceptNecessaryBtn: "Necessary only",
      showPreferencesBtn: "Manage preferences",
      footer: footerLinks,
    },
    preferencesModal: {
      title: "Cookie preferences",
      acceptAllBtn: "Accept all",
      acceptNecessaryBtn: "Necessary only",
      savePreferencesBtn: "Save preferences",
      closeIconLabel: "Close",
      sections: [{ description: prefsLead }, ...categorySections],
    },
  };
}
