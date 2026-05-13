/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Strategy } from "@cocalc/util/types/sso";
import { GOOGLE_SSO_STRATEGY, getGoogleSsoSettingsState } from "./google-sso";
import { getEnabledSsoProviders, ssoProviderToStrategy } from "./sso-providers";
import {
  applyDomainPoliciesToStrategyList,
  getEnabledSsoDomainPolicies,
} from "./sso-policies";

const CACHE_TTL_MS = process.env.NODE_ENV === "development" ? 3_000 : 15_000;
let cachedStrategies:
  | {
      expires: number;
      value: Strategy[];
    }
  | undefined;

/** Returns an array of public info about strategies.
 * Cached a bit so safe to call a lot.
 */
export default async function getStrategies(): Promise<Strategy[]> {
  if (cachedStrategies && cachedStrategies.expires > Date.now()) {
    return cachedStrategies.value;
  }
  const [googleSso, domainPolicies] = await Promise.all([
    getGoogleSsoSettingsState(),
    getEnabledSsoDomainPolicies(),
  ]);
  const ssoProviders = await getEnabledSsoProviders();
  const strategies: Strategy[] = [];
  for (const strategy of ssoProviders.flatMap((provider) => {
    const strategy = ssoProviderToStrategy(provider);
    return strategy == null ? [] : [strategy];
  })) {
    if (!strategies.some((existing) => existing.name === strategy.name)) {
      strategies.push(strategy);
    }
  }
  if (googleSso.strategy != null) {
    strategies.push({
      name: GOOGLE_SSO_STRATEGY,
      display: "Google",
      icon: "google",
      backgroundColor: COLORS.google,
      public: true,
      exclusiveDomains: googleSso.allowedDomains,
      doNotHide: false,
    });
  }
  const value = applyDomainPoliciesToStrategyList(strategies, domainPolicies);
  cachedStrategies = {
    expires: Date.now() + CACHE_TTL_MS,
    value,
  };
  return value;
}

export const COLORS = {
  google: "#dc4857",
} as const;
