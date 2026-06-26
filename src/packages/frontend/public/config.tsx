/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { createContext, useContext } from "react";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { SITE_NAME } from "@cocalc/util/theme";
import type { SignupEmailDomainPublicPolicy } from "@cocalc/util/accounts/signup-email-domain-policy";
import type { PassportStrategyFrontend } from "@cocalc/util/types/passport-types";
import { joinUrlPath } from "@cocalc/util/url-path";

export interface PublicConfig {
  account_display_name?: string;
  account_email_address?: string;
  account_creation_email_instructions?: string;
  account_id?: string;
  cookie_banner_enabled?: boolean;
  cookie_banner_text?: string;
  help_email?: string;
  imprint?: string;
  is_admin?: boolean;
  is_authenticated?: boolean;
  logo_square?: string;
  on_cocalc_com?: boolean;
  policies?: string;
  policy_pages?: PublicPolicyPages;
  site_name?: string;
  sign_in_email_instructions?: string;
  signup_email_domain_public_policy?: SignupEmailDomainPublicPolicy;
  strategies?: PassportStrategyFrontend[];
  terms_of_service_url?: string;
}

export type PublicPolicyPages = "none" | "custom" | "sagemathinc";

const PublicConfigContext = createContext<PublicConfig | undefined>(undefined);
export const COCALC_WORDMARK_BLACK_URL = joinUrlPath(
  appBasePath,
  "webapp/cocalc-font-black.svg",
);
export const COCALC_WORDMARK_WHITE_URL = joinUrlPath(
  appBasePath,
  "webapp/cocalc-font-white.svg",
);

export function PublicConfigProvider({
  children,
  config,
}: {
  children: ReactNode;
  config?: PublicConfig;
}) {
  return (
    <PublicConfigContext.Provider value={config}>
      {children}
    </PublicConfigContext.Provider>
  );
}

export function usePublicConfig(): PublicConfig | undefined {
  return useContext(PublicConfigContext);
}

export function getSiteName(config?: PublicConfig): string {
  return config?.site_name ?? SITE_NAME;
}

export function getLogoSquare(config?: PublicConfig): string {
  return (
    config?.logo_square?.trim() ||
    joinUrlPath(appBasePath, "webapp/favicon.ico")
  );
}

export function usesDefaultCoCalcBranding(config?: PublicConfig): boolean {
  return !config?.logo_square?.trim() && getSiteName(config) === SITE_NAME;
}

export function getPublicPolicyPages(config?: PublicConfig): PublicPolicyPages {
  const value = config?.policy_pages?.trim();
  return value === "custom" || value === "sagemathinc" ? value : "none";
}

export function getExternalPoliciesUrl(
  config?: PublicConfig,
): string | undefined {
  const url = config?.terms_of_service_url?.trim();
  return url ? url : undefined;
}

export function publicPoliciesUseBuiltin(config?: PublicConfig): boolean {
  return getPublicPolicyPages(config) === "sagemathinc";
}

export function publicPoliciesUseCustom(config?: PublicConfig): boolean {
  return getPublicPolicyPages(config) === "custom";
}

export function arePublicPoliciesVisible(config?: PublicConfig): boolean {
  return (
    getExternalPoliciesUrl(config) != null ||
    getPublicPolicyPages(config) !== "none"
  );
}
