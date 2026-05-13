/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  PassportStrategyDB,
  PassportStrategyDBInfo,
} from "@cocalc/database/settings/auth-sso-types";
import type { Strategy } from "@cocalc/util/types/sso";

export const SSO_DOMAIN_AUTH_MODES = [
  "password_allowed",
  "sso_required",
  "sso_signup_only",
] as const;
export type SsoDomainAuthMode = (typeof SSO_DOMAIN_AUTH_MODES)[number];

export const SSO_SIGNUP_MODES = [
  "inherit",
  "disabled",
  "registration_token_required",
  "public_allowed",
] as const;
export type SsoSignupMode = (typeof SSO_SIGNUP_MODES)[number];

export interface SsoDomainPolicy {
  domain: string;
  provider_id: string;
  mode: SsoDomainAuthMode;
  enabled: boolean;
  require_cocalc_2fa: boolean;
  signup_mode: SsoSignupMode;
  notes?: string;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback;
}

export function normalizeSsoDomain(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase().replace(/^@+/, "");
}

export function normalizeSsoDomainPolicy(row: any): SsoDomainPolicy {
  return {
    domain: normalizeSsoDomain(row?.domain),
    provider_id: `${row?.provider_id ?? ""}`.trim(),
    mode: oneOf(row?.mode, SSO_DOMAIN_AUTH_MODES, "sso_required"),
    enabled: row?.enabled !== false,
    require_cocalc_2fa: row?.require_cocalc_2fa === true,
    signup_mode: oneOf(row?.signup_mode, SSO_SIGNUP_MODES, "inherit"),
    notes: row?.notes,
  };
}

export function requiredSsoDomainsForProvider(
  policies: SsoDomainPolicy[],
  providerID: string,
): string[] {
  const domains = new Set<string>();
  for (const policy of policies) {
    if (
      policy.enabled &&
      policy.mode === "sso_required" &&
      policy.provider_id === providerID &&
      policy.domain
    ) {
      domains.add(policy.domain);
    }
  }
  return [...domains].sort();
}

function mergeDomains(
  existing: string[] | undefined,
  extra: string[],
): string[] {
  return [...new Set([...(existing ?? []), ...extra])].sort();
}

export function applyDomainPoliciesToStrategyList(
  strategies: Strategy[],
  policies: SsoDomainPolicy[],
): Strategy[] {
  return strategies.map((strategy) => ({
    ...strategy,
    exclusiveDomains: mergeDomains(
      strategy.exclusiveDomains,
      requiredSsoDomainsForProvider(policies, strategy.name),
    ),
  }));
}

export function applyDomainPoliciesToPassports(
  passports: { [key: string]: PassportStrategyDB },
  policies: SsoDomainPolicy[],
): void {
  for (const [providerID, strategy] of Object.entries(passports)) {
    const domains = requiredSsoDomainsForProvider(policies, providerID);
    if (domains.length === 0) continue;
    const info: PassportStrategyDBInfo = strategy.info ?? {};
    info.exclusive_domains = mergeDomains(info.exclusive_domains, domains);
    if (info.allowed_domains?.length) {
      info.allowed_domains = mergeDomains(info.allowed_domains, domains);
    }
    strategy.info = info;
  }
}

export async function getEnabledSsoDomainPolicies(): Promise<
  SsoDomainPolicy[]
> {
  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT domain, provider_id, mode, enabled, require_cocalc_2fa, signup_mode, notes
    FROM sso_domain_policies
    WHERE COALESCE(enabled, true) = true`);
  return rows
    .map(normalizeSsoDomainPolicy)
    .filter((policy) => policy.domain && policy.provider_id);
}
