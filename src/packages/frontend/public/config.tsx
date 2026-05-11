/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";
import { createContext, useContext } from "react";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { SITE_NAME } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

export interface PublicConfig {
  help_email?: string;
  imprint?: string;
  is_admin?: boolean;
  is_authenticated?: boolean;
  logo_square?: string;
  on_cocalc_com?: boolean;
  policies?: string;
  show_policies?: boolean;
  site_name?: string;
  terms_of_service_url?: string;
}

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
