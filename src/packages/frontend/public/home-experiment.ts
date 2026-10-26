/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Browser side of the public Home page experiment
// (util/public-home-experiment.ts). Nothing is stored in the browser: the
// version is chosen per page view and travels only in the sign-up link.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  hasCategoryConsent,
  onConsentChange,
} from "@cocalc/frontend/cookie-consent";
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

/** Whether this visitor may be counted. The counts are first-party usage
 * metrics, so on sites with the cookie banner they need the "Usage metrics"
 * consent; without the banner there is no consent to ask for. */
export function publicHomeExperimentAllowed(
  cookieBannerEnabled: boolean,
): boolean {
  return !cookieBannerEnabled || hasCategoryConsent("usage");
}

/** Add one to the aggregate count for this version and event (sign-ups are
 * counted by the server when the account is created). Resolves true only
 * when the server answered that it stored the event; failures resolve false
 * and never affect the page. The request carries no cookies. */
export async function sendPublicHomeExperimentEvent(
  variant: string,
  event: Exclude<PublicHomeExperimentEvent, "signup">,
): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const res = await window.fetch(
      joinUrlPath(appBasePath, "home-experiment"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, event }),
        keepalive: true,
        credentials: "omit",
      },
    );
    return !!res?.ok;
  } catch {
    // never let counting affect the page
    return false;
  }
}

/** For the sign-up forms: when the page was reached from a Home version,
 * count the visit (now, or once the visitor consents), and return a getter
 * for the version to send with the sign-up, which the server counts when the
 * account exists. The getter returns the version only after the server
 * stored the visit, so the counts stay a funnel (views, then visits, then
 * sign-ups); it is state, so links built during render (single sign-on) pick
 * the version up as soon as that happens. */
export function usePublicHomeSignupVariant(
  cookieBannerEnabled: boolean,
  enabled = true,
): () => string | undefined {
  const variant = useMemo(
    () => (enabled ? publicHomeVariantFromSearch() : undefined),
    [enabled],
  );
  const [allowed, setAllowed] = useState(() =>
    publicHomeExperimentAllowed(cookieBannerEnabled),
  );
  useEffect(() => {
    setAllowed(publicHomeExperimentAllowed(cookieBannerEnabled));
    if (!cookieBannerEnabled) return;
    return onConsentChange(() =>
      setAllowed(publicHomeExperimentAllowed(cookieBannerEnabled)),
    );
  }, [cookieBannerEnabled]);
  const sentCta = useRef(false);
  const [counted, setCounted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!variant || !allowed || sentCta.current) return;
    sentCta.current = true;
    void sendPublicHomeExperimentEvent(variant, "cta").then((ok) => {
      if (ok && mounted.current) setCounted(true);
    });
  }, [variant, allowed]);
  return useCallback(
    () => (variant && allowed && counted ? variant : undefined),
    [variant, allowed, counted],
  );
}
