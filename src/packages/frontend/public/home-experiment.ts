/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Browser side of the public Home page experiment
// (util/public-home-experiment.ts). Nothing is stored in the browser: the
// version is chosen per page view and travels only in the sign-up link.

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  isPublicHomeVariantId,
  parsePublicHomeExperimentArms,
  pickPublicHomeVariant,
  PUBLIC_HOME_DEFAULT_VARIANT,
  PUBLIC_HOME_VARIANT_PARAM,
  type PublicHomeExperimentEvent,
} from "@cocalc/util/public-home-experiment";
import { joinUrlPath } from "@cocalc/util/url-path";

export interface PublicHomeVariantChoice {
  variant: string;
  /** Counted as part of the experiment (an anonymous visit while it runs). */
  counted: boolean;
}

/** The version of Home to show for this page view.
 * - `?home=<id>` previews a known version, uncounted;
 * - an anonymous visit while the experiment runs gets a weighted random one;
 * - otherwise the default. */
export function choosePublicHomeVariant({
  setting,
  isAuthenticated,
  search = typeof window === "undefined" ? "" : window.location.search,
  random = Math.random,
}: {
  setting: unknown;
  isAuthenticated: boolean;
  search?: string;
  random?: () => number;
}): PublicHomeVariantChoice {
  const preview = new URLSearchParams(search).get(PUBLIC_HOME_VARIANT_PARAM);
  if (isPublicHomeVariantId(preview)) {
    return { variant: preview, counted: false };
  }
  const arms = isAuthenticated ? [] : parsePublicHomeExperimentArms(setting);
  if (arms.length === 0) {
    return { variant: PUBLIC_HOME_DEFAULT_VARIANT, counted: false };
  }
  return { variant: pickPublicHomeVariant(arms, random()), counted: true };
}

/** The version a sign-up page was reached from, if its link carried one. */
export function publicHomeVariantFromSearch(
  search = typeof window === "undefined" ? "" : window.location.search,
): string | undefined {
  const variant = new URLSearchParams(search).get(PUBLIC_HOME_VARIANT_PARAM);
  return isPublicHomeVariantId(variant) ? variant : undefined;
}

/** Add one to the aggregate count for this version and event. Best effort:
 * failures are ignored and never affect the page. */
export function sendPublicHomeExperimentEvent(
  variant: string,
  event: PublicHomeExperimentEvent,
): void {
  if (typeof window === "undefined") return;
  const url = joinUrlPath(appBasePath, "home-experiment");
  const body = JSON.stringify({ variant, event });
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
    ) {
      return;
    }
    void window
      .fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "omit",
      })
      .catch(() => {});
  } catch {
    // never let counting affect the page
  }
}
