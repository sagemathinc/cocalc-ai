/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  PassportStrategyDB,
  PassportStrategyDBInfo,
} from "@cocalc/database/settings/auth-sso-types";
import { ssoDispayedName } from "@cocalc/util/auth";
import type { Strategy } from "@cocalc/util/types/sso";

import {
  SSO_SIGNUP_MODES,
  type SsoSignupMode,
  normalizeSsoDomain,
} from "./sso-policies";

export const SSO_PROVIDER_KINDS = ["google_oidc", "saml", "oidc"] as const;
export type SsoProviderKind = (typeof SSO_PROVIDER_KINDS)[number];

export interface SsoProvider {
  provider_id: string;
  kind: SsoProviderKind;
  display?: string;
  enabled: boolean;
  public: boolean;
  config: Record<string, any>;
  notes?: string;
}

export const SSO_PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  return allowed.includes(value as T[number])
    ? (value as T[number])
    : undefined;
}

export function isValidSsoProviderID(value: unknown): boolean {
  return SSO_PROVIDER_ID_RE.test(`${value ?? ""}`.trim());
}

function asObject(value: unknown): Record<string, any> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

export function normalizeSsoProvider(row: any): SsoProvider | undefined {
  const provider_id = `${row?.provider_id ?? ""}`.trim();
  const kind = oneOf(row?.kind, SSO_PROVIDER_KINDS);
  if (!provider_id || !isValidSsoProviderID(provider_id) || kind == null) {
    return undefined;
  }
  const config = asObject(row?.config);
  return {
    provider_id,
    kind,
    display: `${row?.display ?? config.display ?? ""}`.trim() || undefined,
    enabled: row?.enabled !== false,
    public: row?.public === true,
    config,
    notes: row?.notes,
  };
}

export function normalizeSsoProviderDomains(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeSsoProviderDomains);
  }
  return `${value ?? ""}`
    .split(",")
    .map(normalizeSsoDomain)
    .filter((domain) => domain.length > 0);
}

function normalizeSignupMode(
  value: unknown,
): Exclude<SsoSignupMode, "inherit"> | undefined {
  const mode = oneOf(value, SSO_SIGNUP_MODES) as SsoSignupMode | undefined;
  return mode === "inherit" ? undefined : mode;
}

export function ssoProviderToStrategy(
  provider: SsoProvider,
): Strategy | undefined {
  if (!provider.enabled || provider.kind === "google_oidc") {
    return undefined;
  }
  const config = provider.config;
  return {
    name: provider.provider_id,
    display: ssoDispayedName({
      display: provider.display ?? config.display,
      name: provider.provider_id,
    }),
    icon: config.icon,
    backgroundColor:
      typeof config.backgroundColor === "string" ? config.backgroundColor : "",
    public: provider.public,
    exclusiveDomains: normalizeSsoProviderDomains(config.exclusive_domains),
    doNotHide: config.do_not_hide === true,
  };
}

export function ssoProviderToPassportStrategy(
  provider: SsoProvider,
): PassportStrategyDB | undefined {
  if (!provider.enabled || provider.kind !== "saml") {
    return undefined;
  }
  const config = provider.config;
  const info: PassportStrategyDBInfo = {
    public: provider.public,
    display: provider.display ?? config.display,
    description: config.description,
    icon: config.icon,
    do_not_hide: config.do_not_hide === true,
    exclusive_domains: normalizeSsoProviderDomains(config.exclusive_domains),
    allowed_domains: normalizeSsoProviderDomains(config.allowed_domains),
    update_on_login: config.update_on_login === true,
    cookie_ttl_s:
      typeof config.cookie_ttl_s === "number" ? config.cookie_ttl_s : undefined,
    account_creation:
      normalizeSignupMode(config.account_creation) ??
      "registration_token_required",
  };

  return {
    strategy: provider.provider_id,
    conf: {
      type: "saml",
      ...config,
    },
    info,
  };
}

export async function getEnabledSsoProviders(): Promise<SsoProvider[]> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT provider_id, kind, display, enabled, public, config, notes
    FROM sso_providers
    WHERE COALESCE(enabled, true) = true`);
  return rows
    .map(normalizeSsoProvider)
    .filter((provider): provider is SsoProvider => provider != null);
}

export async function getEnabledSamlSsoProviders(): Promise<SsoProvider[]> {
  return (await getEnabledSsoProviders()).filter(
    (provider) => provider.kind === "saml",
  );
}
