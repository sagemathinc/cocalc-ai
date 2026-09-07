/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import * as CookieConsent from "vanilla-cookieconsent";
import "vanilla-cookieconsent/dist/cookieconsent.css";
import "./appearance.css";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

import { loadFirstPartyAnalytics } from "./analytics";
import { COOKIE_CATEGORIES, type CookieCategory } from "./categories";
import { COOKIE_CONSENT_REVISION } from "./index";
import {
  markBannerActive,
  markBannerDecidedDisabled,
  markBannerReady,
} from "./state";
import { buildTranslation } from "./translations";

function buildCategoriesConfig(): Record<string, CookieConsent.Category> {
  const result: Record<string, CookieConsent.Category> = {};
  for (const raw of COOKIE_CATEGORIES) {
    const category: CookieCategory = raw;
    const entry: CookieConsent.Category = {
      enabled: category.defaultEnabled,
      readOnly: category.readOnly,
    };
    if (
      category.autoClearCookies != null &&
      category.autoClearCookies.length > 0
    ) {
      entry.autoClear = {
        cookies: category.autoClearCookies.map((item) => ({
          name: item.name,
        })),
      };
    }
    result[category.key] = entry;
  }
  return result;
}

let initialized = false;

export interface InitOptions {
  enabled?: boolean;
  textMarkdown?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function markdownToHtml(text: string): string {
  const escaped = escapeHtml(text);
  const linked = escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  return linked
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`)
    .join("");
}

export function initCookieConsent({
  enabled,
  textMarkdown,
}: InitOptions): void {
  if (initialized) return;
  if (typeof window === "undefined") return;
  if (!enabled) {
    markBannerDecidedDisabled();
    return;
  }
  initialized = true;
  markBannerActive();

  const descHtml = markdownToHtml(textMarkdown?.trim() || "");
  const privacyUrl = joinUrlPath(appBasePath, "policies/privacy");
  const termsUrl = joinUrlPath(appBasePath, "policies/terms");
  const maybeLoadAnalytics = () => {
    void loadFirstPartyAnalytics().catch((err: unknown) =>
      console.error("cookie-consent: analytics load failed", err),
    );
  };
  window.addEventListener("cc:onConsent", maybeLoadAnalytics);
  window.addEventListener("cc:onChange", maybeLoadAnalytics);

  try {
    void CookieConsent.run({
      revision: COOKIE_CONSENT_REVISION,
      guiOptions: {
        consentModal: {
          layout: "box inline",
          position: "middle center",
          equalWeightButtons: true,
          flipButtons: false,
        },
        preferencesModal: {
          layout: "bar",
          position: "right",
          equalWeightButtons: true,
          flipButtons: false,
        },
      },
      categories: buildCategoriesConfig(),
      // CookieConsent normally hides from WebDriver. CoCalc's signup flow
      // requires consent, so hiding the modal would deadlock browser automation.
      hideFromBots: navigator.webdriver !== true,
      language: {
        default: "en",
        translations: {
          en: buildTranslation(descHtml, privacyUrl, termsUrl),
        },
      },
    })
      .then(() => {
        markBannerReady();
        maybeLoadAnalytics();
      })
      .catch((err: unknown) =>
        console.error("cookie-consent: run rejected", err),
      );
  } catch (err) {
    console.error("cookie-consent: run threw", err);
  }
}
