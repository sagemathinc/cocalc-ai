/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import type {
  AccountEntitlementOverride,
  AccountFeatureOverrides,
  AccountUsageLimitOverrides,
  AiLimitOverrides,
  DedicatedHostPolicyOverrides,
  MembershipEntitlements,
  MembershipResolution,
  MembershipUsageLimits,
  NumericLimitRule,
  ProjectDefaultOverrides,
} from "@cocalc/conat/hub/api/purchases";
import { normalizeMembershipEffectiveLimits } from "./effective-limits";

const NUMERIC_RULE_MODES = new Set(["minimum", "maximum", "set"]);
const FEATURE_KEYS = new Set<keyof AccountFeatureOverrides>(["create_hosts"]);
const PROJECT_DEFAULT_KEYS = [
  "disk_quota",
  "memory",
  "memory_request",
] as const satisfies readonly (keyof ProjectDefaultOverrides)[];
const PROJECT_DEFAULT_KEY_SET = new Set<string>(PROJECT_DEFAULT_KEYS);
const AI_LIMIT_KEYS = [
  "units_5h",
  "units_7d",
] as const satisfies readonly (keyof AiLimitOverrides)[];
const AI_LIMIT_KEY_SET = new Set<string>(AI_LIMIT_KEYS);
const NUMERIC_USAGE_LIMIT_KEYS = new Set<keyof MembershipUsageLimits>([
  "shared_compute_priority",
  "total_storage_soft_bytes",
  "total_storage_hard_bytes",
  "max_projects",
  "max_snapshots_per_project",
  "max_backups_per_project",
  "egress_5h_bytes",
  "egress_7d_bytes",
  "credit_spend_limit_5h_usd",
  "credit_spend_limit_7d_usd",
  "prepaid_host_usage_limit_5h_usd",
  "prepaid_host_usage_limit_7d_usd",
]);
const USAGE_ENUM_VALUES = {
  egress_policy: new Set([
    "metered-shared-hosts",
    "all-shared-hosts",
    "disabled",
  ]),
  dedicated_host_egress_policy: new Set([
    "tier-capped",
    "meter-and-bill",
    "disabled",
  ]),
} as const;
const DEDICATED_HOST_FUNDING_MODES = new Set([
  "account-prepaid",
  "account-postpaid",
  "site-funded",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeNumericRule(
  value: unknown,
  path: string,
): NumericLimitRule | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) {
    throw Error(`${path} must be a numeric limit rule`);
  }
  const mode = value.mode;
  const ruleValue = value.value;
  if (typeof mode !== "string" || !NUMERIC_RULE_MODES.has(mode)) {
    throw Error(`${path}.mode must be minimum, maximum, or set`);
  }
  if (
    typeof ruleValue !== "number" ||
    !Number.isFinite(ruleValue) ||
    ruleValue < 0
  ) {
    throw Error(`${path}.value must be a nonnegative finite number`);
  }
  return {
    mode: mode as NumericLimitRule["mode"],
    value: ruleValue,
  };
}

function normalizeEnumOverride<T extends string>({
  value,
  allowed,
  path,
}: {
  value: unknown;
  allowed: Set<string>;
  path: string;
}): { mode: "set"; value: T } | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) {
    throw Error(`${path} must be an enum override`);
  }
  if (value.mode !== "set") {
    throw Error(`${path}.mode must be set`);
  }
  if (typeof value.value !== "string" || !allowed.has(value.value)) {
    throw Error(`${path}.value is not valid`);
  }
  return { mode: "set", value: value.value as T };
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw Error(`${path}.${key} is not a supported override key`);
    }
  }
}

function normalizeFeatures(
  value: unknown,
): AccountFeatureOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("features must be an object");
  assertNoUnknownKeys(value, FEATURE_KEYS as Set<string>, "features");
  const features: AccountFeatureOverrides = {};
  if (value.create_hosts != null) {
    if (typeof value.create_hosts !== "boolean") {
      throw Error("features.create_hosts must be a boolean");
    }
    features.create_hosts = value.create_hosts;
  }
  return features;
}

function normalizeProjectDefaults(
  value: unknown,
): ProjectDefaultOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("project_defaults must be an object");
  assertNoUnknownKeys(value, PROJECT_DEFAULT_KEY_SET, "project_defaults");
  const projectDefaults: ProjectDefaultOverrides = {};
  for (const key of PROJECT_DEFAULT_KEYS) {
    const rule = normalizeNumericRule(value[key], `project_defaults.${key}`);
    if (rule) {
      projectDefaults[key] = rule;
    }
  }
  return projectDefaults;
}

function normalizeAiLimits(value: unknown): AiLimitOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("ai_limits must be an object");
  assertNoUnknownKeys(value, AI_LIMIT_KEY_SET, "ai_limits");
  const aiLimits: AiLimitOverrides = {};
  for (const key of AI_LIMIT_KEYS) {
    const rule = normalizeNumericRule(value[key], `ai_limits.${key}`);
    if (rule) {
      aiLimits[key] = rule;
    }
  }
  return aiLimits;
}

function normalizeUsageLimits(
  value: unknown,
): AccountUsageLimitOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("usage_limits must be an object");
  assertNoUnknownKeys(
    value,
    new Set([
      ...NUMERIC_USAGE_LIMIT_KEYS,
      ...Object.keys(USAGE_ENUM_VALUES),
    ]) as Set<string>,
    "usage_limits",
  );
  const usageLimits: AccountUsageLimitOverrides = {};
  for (const key of NUMERIC_USAGE_LIMIT_KEYS) {
    const rule = normalizeNumericRule(value[key], `usage_limits.${key}`);
    if (rule) {
      (usageLimits as Record<string, NumericLimitRule>)[key] = rule;
    }
  }
  usageLimits.egress_policy = normalizeEnumOverride({
    value: value.egress_policy,
    allowed: USAGE_ENUM_VALUES.egress_policy,
    path: "usage_limits.egress_policy",
  });
  usageLimits.dedicated_host_egress_policy = normalizeEnumOverride({
    value: value.dedicated_host_egress_policy,
    allowed: USAGE_ENUM_VALUES.dedicated_host_egress_policy,
    path: "usage_limits.dedicated_host_egress_policy",
  });
  return usageLimits;
}

function normalizeDedicatedHosts(
  value: unknown,
): DedicatedHostPolicyOverrides | undefined {
  if (value == null) return undefined;
  if (!isObject(value)) throw Error("dedicated_hosts must be an object");
  assertNoUnknownKeys(
    value,
    new Set(["funding_mode", "postpaid_unbilled_limit_usd"]),
    "dedicated_hosts",
  );
  return {
    funding_mode: normalizeEnumOverride({
      value: value.funding_mode,
      allowed: DEDICATED_HOST_FUNDING_MODES,
      path: "dedicated_hosts.funding_mode",
    }),
    postpaid_unbilled_limit_usd: normalizeNumericRule(
      value.postpaid_unbilled_limit_usd,
      "dedicated_hosts.postpaid_unbilled_limit_usd",
    ),
  };
}

function emptyToUndefined<T extends object>(
  value: T | undefined,
): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

export function normalizeAccountEntitlementOverride(
  row: unknown,
): AccountEntitlementOverride | undefined {
  if (row == null) return undefined;
  if (!isObject(row)) {
    throw Error("account entitlement override must be an object");
  }
  const account_id = row.account_id;
  const updated_by = row.updated_by;
  if (typeof account_id !== "string" || account_id.length === 0) {
    throw Error("account_id is required");
  }
  if (typeof updated_by !== "string" || updated_by.length === 0) {
    throw Error("updated_by is required");
  }
  return {
    account_id,
    enabled: row.enabled !== false,
    features: emptyToUndefined(normalizeFeatures(row.features)),
    project_defaults: emptyToUndefined(
      normalizeProjectDefaults(row.project_defaults),
    ),
    ai_limits: emptyToUndefined(normalizeAiLimits(row.ai_limits)),
    usage_limits: emptyToUndefined(normalizeUsageLimits(row.usage_limits)),
    dedicated_hosts: emptyToUndefined(
      normalizeDedicatedHosts(row.dedicated_hosts),
    ),
    reason: typeof row.reason === "string" ? row.reason : null,
    expires_at:
      (row.expires_at as AccountEntitlementOverride["expires_at"]) ?? null,
    updated_by,
    updated_at:
      (row.updated_at as AccountEntitlementOverride["updated_at"]) ??
      new Date().toISOString(),
  };
}

export async function getActiveAccountEntitlementOverride(
  account_id: string,
  client?: PoolClient,
): Promise<AccountEntitlementOverride | undefined> {
  const pool = client ?? getPool("medium");
  try {
    const { rows } = await pool.query(
      `SELECT account_id, enabled, features, project_defaults, ai_limits,
              usage_limits, dedicated_hosts, reason, expires_at, updated_by,
              updated_at
         FROM account_entitlement_overrides
        WHERE account_id=$1
          AND enabled IS TRUE
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1`,
      [account_id],
    );
    return normalizeAccountEntitlementOverride(rows[0]);
  } catch (err) {
    if ((err as { code?: string })?.code === "42P01") {
      return undefined;
    }
    throw err;
  }
}

export function applyNumericLimitRule(
  base: number | undefined,
  rule?: NumericLimitRule,
): number | undefined {
  if (!rule) return base;
  if (base == null) return rule.value;
  switch (rule.mode) {
    case "minimum":
      return Math.max(base, rule.value);
    case "maximum":
      return Math.min(base, rule.value);
    case "set":
      return rule.value;
    default:
      return base;
  }
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function applyNumericRulesByKey(
  base: Record<string, unknown> | undefined,
  rules: Record<string, NumericLimitRule> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !rules) return base;
  const result: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, rule] of Object.entries(rules ?? {})) {
    result[key] = applyNumericLimitRule(numberFromUnknown(result[key]), rule);
  }
  return result;
}

function applyUsageLimitOverrides(
  base: MembershipUsageLimits | undefined,
  overrides: AccountUsageLimitOverrides | undefined,
): MembershipUsageLimits | undefined {
  if (!base && !overrides) return base;
  const result: MembershipUsageLimits = { ...(base ?? {}) };
  for (const key of NUMERIC_USAGE_LIMIT_KEYS) {
    const rule = overrides?.[key] as NumericLimitRule | undefined;
    if (rule) {
      (result as Record<string, number | undefined>)[key] =
        applyNumericLimitRule(
          numberFromUnknown((result as Record<string, unknown>)[key]),
          rule,
        );
    }
  }
  if (overrides?.egress_policy) {
    result.egress_policy = overrides.egress_policy.value;
  }
  if (overrides?.dedicated_host_egress_policy) {
    result.dedicated_host_egress_policy =
      overrides.dedicated_host_egress_policy.value;
  }
  return normalizeMembershipEffectiveLimits(result);
}

export function applyAccountEntitlementOverride({
  membership,
  override,
}: {
  membership: MembershipResolution;
  override?: AccountEntitlementOverride;
}): MembershipResolution {
  if (!override) return membership;
  const baseEntitlements = membership.entitlements ?? {};
  const entitlements: MembershipEntitlements = {
    ...baseEntitlements,
    features: {
      ...(baseEntitlements.features ?? {}),
      ...(override.features ?? {}),
    },
    project_defaults: applyNumericRulesByKey(
      baseEntitlements.project_defaults,
      override.project_defaults as Record<string, NumericLimitRule> | undefined,
    ),
    ai_limits: applyNumericRulesByKey(
      baseEntitlements.ai_limits,
      override.ai_limits as Record<string, NumericLimitRule> | undefined,
    ),
  };
  const effective_limits = applyUsageLimitOverrides(
    membership.effective_limits ?? baseEntitlements.usage_limits,
    override.usage_limits,
  );
  entitlements.usage_limits = effective_limits;
  return {
    ...membership,
    entitlements,
    effective_limits,
  };
}
