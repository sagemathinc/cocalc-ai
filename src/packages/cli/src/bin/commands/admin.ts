import { Command } from "commander";
import { createHash } from "node:crypto";
import { ADMIN_SEARCH_LIMIT } from "@cocalc/util/db-schema/accounts";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS } from "@cocalc/util/membership-entitlement-overrides";
import { currency } from "@cocalc/util/misc";
import {
  createSiteMasterKeyBackup,
  getOrCreateSiteMasterKey,
  getSiteMasterKeyStatus,
  readSiteMasterKeyBackupFile,
  restoreSiteMasterKeyBackup,
} from "@cocalc/util/master-key-lifecycle";
import { readFile, writeFile } from "node:fs/promises";
import type { AccountEntitlementOverride } from "@cocalc/conat/hub/api/purchases";
import type {
  AdminDataQueryKind,
  AdminDataViewExport,
  AdminDataViewInput,
} from "@cocalc/conat/hub/api/admin-data-explorer";
import type { AdminDbDiagnostic } from "@cocalc/conat/hub/api/admin-db";
import {
  ADMIN_SUPPORT_CONVENTIONS,
  ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES,
  ADMIN_SUPPORT_TICKET_PRIORITIES,
  ADMIN_SUPPORT_TICKET_STATUSES,
  type AdminSupportMutableTicketStatus,
  type AdminSupportTicketPriority,
  type AdminSupportTicketStatus,
  type AdminSupportUpdateChanges,
} from "@cocalc/conat/hub/api/admin-support";
import {
  ADMIN_CRASH_STATUSES,
  type AdminCrashStatus,
} from "@cocalc/conat/hub/api/admin-crashes";
import {
  HOST_RUNTIME_LOG_SOURCES,
  type HostRuntimeLogSource,
} from "@cocalc/conat/project-host/api";
import { ADMIN_DATA_EXPLORER_STARTER_VIEWS } from "@cocalc/conat/hub/api/admin-data-explorer";
import {
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES,
  ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS,
  ADMIN_DATA_EXPLORER_SQL_MAX_BYTES,
  ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
  ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS,
} from "@cocalc/util/admin-data-explorer";
import type {
  LaunchHealthStatus,
  LaunchSmokeResult,
  LaunchSmokeStepResult,
} from "@cocalc/conat/hub/api/system";
import { registerReceivablesCommand } from "./admin/receivables";
import { registerCrmCommand } from "./admin/crm";

const ADMIN_HOST_INTRUSION_SNAPSHOT_TIMEOUT_MS = 130_000;

export type AdminCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  isValidUUID: any;
  waitForLro: any;
};

type AccountEntitlementOverrideInput = Omit<
  Partial<AccountEntitlementOverride>,
  "account_id" | "updated_by" | "updated_at"
>;

const NUMERIC_RULE_MODES = {
  minimum:
    "Use the override value only when it is higher than the membership value.",
  maximum:
    "Use the override value only when it is lower than the membership value.",
  set: "Use the override value exactly, replacing the membership value.",
} as const;

const ENTITLEMENT_OVERRIDE_HELP = `
Schema:
  Run "cocalc admin entitlement-override schema" for the accepted JSON payload.

Example:
  cat > /tmp/override.json <<'JSON'
  {
    "enabled": true,
    "project_defaults": {
      "disk_quota": { "mode": "minimum", "value": 45000 }
    },
    "usage_limits": {
      "credit_spend_limit_7d_usd": { "mode": "minimum", "value": 1000 }
    }
  }
  JSON
  cocalc admin entitlement-override set user@example.com --file /tmp/override.json --reason "temporary support increase" --expires-at 2026-05-17T00:00:00Z
`;

const MEMBERSHIP_TIER_FIELDS = {
  id: "*",
  label: null,
  store_visible: null,
  course_store_visible: null,
  priority: null,
  price_monthly: null,
  price_yearly: null,
  trial_days: null,
  course_price: null,
  course_duration_days: null,
  course_grace_days: null,
  disabled: null,
  subscription_count: null,
  subscribed_account_count: null,
  admin_assigned_count: null,
  site_license_count: null,
  updated: null,
} as const;

function parseAdminPackagePositiveInteger(
  value: string | undefined,
  flagName: string,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseAdminPackagePrice(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--price must be a finite nonnegative number");
  }
  return parsed;
}

function parseAdminPackageMetadata(
  value: string | undefined,
): Record<string, unknown> | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid --metadata-json: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--metadata-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseAdminPackageKind(value: string | undefined) {
  if (value === "course" || value === "team" || value === "site") {
    return value;
  }
  throw new Error("--kind must be course, team, or site");
}

function parseAdminPackageDate(value: string | undefined, flagName: string) {
  const date = new Date(`${value ?? ""}`.trim());
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${flagName} must be an ISO date`);
  }
  return date.toISOString();
}

function parseAdminDataQueryKind(
  value: string | undefined,
): AdminDataQueryKind | undefined {
  if (value == null || value === "") return undefined;
  if (value === "structured" || value === "sql" || value === "dataset") {
    return value;
  }
  throw new Error("--kind must be one of structured, sql, dataset");
}

function parseAdminDataImportMode(
  value: string | undefined,
): "upsert" | "create_only" {
  if (value == null || value === "" || value === "upsert") return "upsert";
  if (value === "create_only" || value === "create-only") return "create_only";
  throw new Error("--mode must be upsert or create-only");
}

function parseAdminSupportStatuses(value: string): AdminSupportTicketStatus[] {
  const allowed = new Set<string>(ADMIN_SUPPORT_TICKET_STATUSES);
  const statuses = [
    ...new Set(
      `${value ?? ""}`
        .split(",")
        .map((status) => status.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (statuses.length === 0) {
    throw new Error("--status must contain at least one ticket status");
  }
  for (const status of statuses) {
    if (!allowed.has(status)) {
      throw new Error(
        `--status must contain only: ${ADMIN_SUPPORT_TICKET_STATUSES.join(", ")}`,
      );
    }
  }
  return statuses as AdminSupportTicketStatus[];
}

function parseAdminCrashStatus(value: string | undefined): AdminCrashStatus {
  const status = `${value ?? "open"}`.trim().toLowerCase();
  if (!(ADMIN_CRASH_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `--status must be one of: ${ADMIN_CRASH_STATUSES.join(", ")}`,
    );
  }
  return status as AdminCrashStatus;
}

async function readAdminDataJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse JSON from ${path}: ${err}`);
  }
}

async function readAdminDataSqlInput({
  query,
  file,
}: {
  query?: string;
  file?: string;
}): Promise<string> {
  const sql =
    query != null ? `${query}` : file ? await readFile(file, "utf8") : "";
  if (!sql.trim()) {
    throw new Error("provide SQL with --query or --file");
  }
  return sql;
}

async function readAdminDbSqlInput({
  sql,
  file,
}: {
  sql?: string;
  file?: string;
}): Promise<string> {
  const raw = sql != null ? `${sql}` : file ? await readFile(file, "utf8") : "";
  if (!raw.trim()) {
    throw new Error("provide SQL with --sql or --file");
  }
  return raw;
}

type MembershipTierRow = {
  id?: string | null;
  label?: string | null;
  store_visible?: boolean | null;
  course_store_visible?: boolean | null;
  priority?: number | null;
  price_monthly?: number | string | null;
  price_yearly?: number | string | null;
  trial_days?: number | null;
  course_price?: number | string | null;
  course_duration_days?: number | null;
  course_grace_days?: number | null;
  disabled?: boolean | null;
  subscription_count?: number | string | null;
  subscribed_account_count?: number | string | null;
  admin_assigned_count?: number | string | null;
  site_license_count?: number | string | null;
  updated?: string | Date | null;
};

function fieldDoc({
  path,
  label,
  unit,
  description,
}: {
  path: string;
  label: string;
  unit?: string;
  description?: string;
}) {
  return {
    path,
    kind: "numeric_rule",
    label,
    unit: unit ?? null,
    description: description ?? null,
  };
}

export function buildEntitlementOverrideSchemaDoc() {
  const descriptions = MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS;
  return {
    purpose:
      "One account can have at most one active admin entitlement override. Setting a new override replaces the previous one.",
    set_command:
      "cocalc admin entitlement-override set <user> --file override.json --reason <reason> [--expires-at <iso|none|never>]",
    clear_command:
      "cocalc admin entitlement-override clear <user> --reason <reason>",
    root_fields: {
      enabled:
        "Optional boolean. Defaults to true. Set false only to store a disabled override record.",
      expires_at:
        "Optional ISO-8601 timestamp or null. The CLI --expires-at option can also set this.",
      reason:
        "Do not put this in the JSON file. Pass the audit reason via --reason.",
    },
    numeric_rule: {
      shape: { mode: "minimum | maximum | set", value: "nonnegative number" },
      modes: NUMERIC_RULE_MODES,
    },
    enum_rule: {
      shape: { mode: "set", value: "one of the documented enum values" },
    },
    fields: [
      {
        path: "features.create_hosts",
        kind: "boolean",
        label: "Create dedicated hosts",
        description:
          "Whether this account is allowed to create dedicated project hosts.",
      },
      {
        path: "features.bandwidth_relay_abuse_exempt",
        kind: "boolean",
        label: descriptions.features.bandwidth_relay_abuse_exempt.label,
        description:
          descriptions.features.bandwidth_relay_abuse_exempt.adminDescription,
      },
      {
        path: "features.cryptomining_abuse_exempt",
        kind: "boolean",
        label: descriptions.features.cryptomining_abuse_exempt.label,
        description:
          descriptions.features.cryptomining_abuse_exempt.adminDescription,
      },
      fieldDoc({
        path: "project_defaults.disk_quota",
        ...descriptions.project_defaults.disk_quota,
        description: descriptions.project_defaults.disk_quota.adminDescription,
      }),
      fieldDoc({
        path: "project_defaults.memory",
        ...descriptions.project_defaults.memory,
        description: descriptions.project_defaults.memory.adminDescription,
      }),
      fieldDoc({
        path: "project_defaults.memory_request",
        ...descriptions.project_defaults.memory_request,
        description:
          descriptions.project_defaults.memory_request.adminDescription,
      }),
      fieldDoc({
        path: "ai_limits.units_5h",
        ...descriptions.ai_limits.units_5h,
        description: descriptions.ai_limits.units_5h.adminDescription,
      }),
      fieldDoc({
        path: "ai_limits.units_7d",
        ...descriptions.ai_limits.units_7d,
        description: descriptions.ai_limits.units_7d.adminDescription,
      }),
      {
        path: "usage_limits.shared_compute_priority",
        kind: "numeric_rule",
        label: "Shared compute priority",
        unit: null,
        description:
          "Scheduler priority for non-dedicated shared compute projects.",
      },
      fieldDoc({
        path: "usage_limits.total_storage_soft_bytes",
        ...descriptions.usage_limits.total_storage_soft_bytes,
        unit: "bytes",
        description:
          descriptions.usage_limits.total_storage_soft_bytes.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.total_storage_hard_bytes",
        ...descriptions.usage_limits.total_storage_hard_bytes,
        unit: "bytes",
        description:
          descriptions.usage_limits.total_storage_hard_bytes.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.max_projects",
        ...descriptions.usage_limits.max_projects,
        description: descriptions.usage_limits.max_projects.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.max_snapshots_per_project",
        ...descriptions.usage_limits.max_snapshots_per_project,
        description:
          descriptions.usage_limits.max_snapshots_per_project.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.max_backups_per_project",
        ...descriptions.usage_limits.max_backups_per_project,
        description:
          descriptions.usage_limits.max_backups_per_project.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.egress_5h_bytes",
        ...descriptions.usage_limits.egress_5h_bytes,
        unit: "bytes",
        description: descriptions.usage_limits.egress_5h_bytes.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.egress_7d_bytes",
        ...descriptions.usage_limits.egress_7d_bytes,
        unit: "bytes",
        description: descriptions.usage_limits.egress_7d_bytes.adminDescription,
      }),
      {
        path: "usage_limits.egress_policy",
        kind: "enum_rule",
        label: "Shared-host egress policy",
        values: ["metered-shared-hosts", "all-shared-hosts", "disabled"],
        description:
          "Advanced/internal policy switch for shared-host egress accounting.",
      },
      {
        path: "usage_limits.dedicated_host_egress_policy",
        kind: "enum_rule",
        label: "Dedicated-host egress policy",
        values: ["tier-capped", "meter-and-bill", "disabled"],
        description:
          "Advanced/internal policy switch for dedicated-host egress accounting.",
      },
      fieldDoc({
        path: "usage_limits.credit_spend_limit_5h_usd",
        ...descriptions.usage_limits.credit_spend_limit_5h_usd,
        description:
          descriptions.usage_limits.credit_spend_limit_5h_usd.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.credit_spend_limit_7d_usd",
        ...descriptions.usage_limits.credit_spend_limit_7d_usd,
        description:
          descriptions.usage_limits.credit_spend_limit_7d_usd.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.prepaid_host_usage_limit_5h_usd",
        ...descriptions.usage_limits.prepaid_host_usage_limit_5h_usd,
        description:
          descriptions.usage_limits.prepaid_host_usage_limit_5h_usd
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.prepaid_host_usage_limit_7d_usd",
        ...descriptions.usage_limits.prepaid_host_usage_limit_7d_usd,
        description:
          descriptions.usage_limits.prepaid_host_usage_limit_7d_usd
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_queued_per_account",
        ...descriptions.usage_limits.acp_max_queued_per_account,
        description:
          descriptions.usage_limits.acp_max_queued_per_account.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_queued_per_thread",
        ...descriptions.usage_limits.acp_max_queued_per_thread,
        description:
          descriptions.usage_limits.acp_max_queued_per_thread.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_created_5h_per_account",
        ...descriptions.usage_limits.acp_max_created_5h_per_account,
        description:
          descriptions.usage_limits.acp_max_created_5h_per_account
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_created_7d_per_account",
        ...descriptions.usage_limits.acp_max_created_7d_per_account,
        description:
          descriptions.usage_limits.acp_max_created_7d_per_account
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_running_per_account",
        ...descriptions.usage_limits.acp_max_running_per_account,
        description:
          descriptions.usage_limits.acp_max_running_per_account
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_running_per_project",
        ...descriptions.usage_limits.acp_max_running_per_project,
        description:
          descriptions.usage_limits.acp_max_running_per_project
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.acp_max_active_automations_per_project",
        ...descriptions.usage_limits.acp_max_active_automations_per_project,
        description:
          descriptions.usage_limits.acp_max_active_automations_per_project
            .adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.blob_account_total_bytes",
        ...descriptions.usage_limits.blob_account_total_bytes,
        unit: "bytes",
        description:
          descriptions.usage_limits.blob_account_total_bytes.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.blob_account_count",
        ...descriptions.usage_limits.blob_account_count,
        description:
          descriptions.usage_limits.blob_account_count.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.blob_project_total_bytes",
        ...descriptions.usage_limits.blob_project_total_bytes,
        unit: "bytes",
        description:
          descriptions.usage_limits.blob_project_total_bytes.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.blob_project_count",
        ...descriptions.usage_limits.blob_project_count,
        description:
          descriptions.usage_limits.blob_project_count.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.rootfs_count",
        ...descriptions.usage_limits.rootfs_count,
        description: descriptions.usage_limits.rootfs_count.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.rootfs_total_storage_gb",
        ...descriptions.usage_limits.rootfs_total_storage_gb,
        description:
          descriptions.usage_limits.rootfs_total_storage_gb.adminDescription,
      }),
      fieldDoc({
        path: "usage_limits.rootfs_max_storage_gb",
        ...descriptions.usage_limits.rootfs_max_storage_gb,
        description:
          descriptions.usage_limits.rootfs_max_storage_gb.adminDescription,
      }),
      {
        path: "dedicated_hosts.funding_mode",
        kind: "enum_rule",
        label: "Dedicated-host funding mode",
        values: ["account-prepaid", "account-postpaid", "site-funded"],
        description:
          "Advanced/internal account-specific dedicated-host funding policy. Setting account-postpaid explicitly authorizes administrator-managed collection without requiring Stripe automatic billing; postpaid spend windows still apply.",
      },
    ],
    examples: {
      temporary_project_disk_increase: {
        enabled: true,
        project_defaults: {
          disk_quota: { mode: "minimum", value: 45000 },
        },
      },
      temporary_postpay_increase: {
        enabled: true,
        usage_limits: {
          credit_spend_limit_5h_usd: { mode: "minimum", value: 500 },
          credit_spend_limit_7d_usd: { mode: "minimum", value: 1250 },
        },
      },
      abuse_throttle: {
        enabled: true,
        ai_limits: {
          units_5h: { mode: "maximum", value: 100 },
          units_7d: { mode: "maximum", value: 500 },
        },
      },
    },
  };
}

function pushString(value: string, values: string[]): string[] {
  values.push(value);
  return values;
}

async function resolveBodyMarkdown(opts: {
  bodyMarkdown?: string;
  bodyFile?: string;
}): Promise<string> {
  const bodyMarkdown = `${opts.bodyMarkdown ?? ""}`.trim();
  const bodyFile = `${opts.bodyFile ?? ""}`.trim();
  if (bodyMarkdown && bodyFile) {
    throw new Error("use exactly one of --body-markdown or --body-file");
  }
  if (bodyMarkdown) {
    return bodyMarkdown;
  }
  if (bodyFile) {
    return await readFile(bodyFile, "utf8");
  }
  throw new Error("one of --body-markdown or --body-file is required");
}

function parseOverrideJson(raw: string): AccountEntitlementOverrideInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid override JSON: ${err}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("override JSON must be an object");
  }
  return parsed as AccountEntitlementOverrideInput;
}

async function readOverrideFile(
  path: string,
): Promise<AccountEntitlementOverrideInput> {
  const filename = `${path ?? ""}`.trim();
  if (!filename) {
    throw new Error("--file is required");
  }
  return parseOverrideJson(await readFile(filename, "utf8"));
}

async function resolvePassphraseOption(opts: {
  passphraseEnv?: string;
  passphraseFile?: string;
}): Promise<string | undefined> {
  const envName = `${opts.passphraseEnv ?? ""}`.trim();
  const file = `${opts.passphraseFile ?? ""}`.trim();
  if (envName && file) {
    throw new Error("use exactly one of --passphrase-env or --passphrase-file");
  }
  if (envName) {
    const value = process.env[envName];
    if (!value) {
      throw new Error(`environment variable ${envName} is not set`);
    }
    return value;
  }
  if (file) {
    return (await readFile(file, "utf8")).trim();
  }
}

async function requirePassphraseOption(opts: {
  passphraseEnv?: string;
  passphraseFile?: string;
}): Promise<string> {
  const passphrase = await resolvePassphraseOption(opts);
  if (!passphrase) {
    throw new Error("one of --passphrase-env or --passphrase-file is required");
  }
  return passphrase;
}

async function loadMasterKeyMigration() {
  return await import("@cocalc/database/settings/master-key-migration");
}

function parseExpiresAtOption(value: string | undefined): string | null | void {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return;
  if (/^(none|null|never)$/i.test(trimmed)) {
    return null;
  }
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("--expires-at must be ISO-8601, none, null, or never");
  }
  return date.toISOString();
}

function requireReason(value: string | undefined): string {
  const reason = `${value ?? ""}`.trim();
  if (!reason) {
    throw new Error("--reason is required");
  }
  return reason;
}

function parseMembershipAssignmentExpiration(value: string): Date | null {
  const parsed = parseExpiresAtOption(value);
  if (parsed === undefined) {
    throw new Error("--expires-at is required");
  }
  if (parsed === null) {
    return null;
  }
  const expiresAt = new Date(parsed);
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error("--expires-at must be in the future, or never");
  }
  return expiresAt;
}

function formatCurrencyValue(value: unknown): string {
  if (value == null || value === "") return "";
  const amount = Number(value);
  return Number.isFinite(amount) ? currency(amount) : `${value}`;
}

function numericCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function yesNo(value: unknown): string {
  return value ? "yes" : "no";
}

function formatSettingValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  return JSON.stringify(value);
}

function formatSiteSettingRow(row: any) {
  return {
    name: row.name ?? "",
    value: row.redacted ? "[redacted]" : formatSettingValue(row.value),
    default: row.redacted
      ? "[redacted]"
      : formatSettingValue(row.default_value),
    configured: yesNo(row.configured),
    readonly: yesNo(row.readonly),
    password: yesNo(row.password),
    hidden: yesNo(row.hidden),
  };
}

function formatDate(value: unknown): string {
  if (value == null || value === "") return "";
  if (value instanceof Date) return value.toISOString();
  return `${value}`;
}

function formatMembershipTierRow(row: MembershipTierRow) {
  return {
    id: row.id ?? "",
    label: row.label ?? "",
    visible: yesNo(row.store_visible),
    course: yesNo(row.course_store_visible),
    priority: row.priority ?? "",
    monthly: formatCurrencyValue(row.price_monthly),
    yearly: formatCurrencyValue(row.price_yearly),
    trial_days: row.trial_days ?? "",
    course_price: formatCurrencyValue(row.course_price),
    course_days: row.course_duration_days ?? "",
    grace_days: row.course_grace_days ?? "",
    subscriptions: numericCount(row.subscription_count),
    subscribed_accounts: numericCount(row.subscribed_account_count),
    admin_assigned: numericCount(row.admin_assigned_count),
    site_licenses: numericCount(row.site_license_count),
    active: row.disabled ? "no" : "yes",
    updated: formatDate(row.updated),
  };
}

function formatMembershipTierCompactRow(row: MembershipTierRow) {
  return {
    id: row.id ?? "",
    label: row.label ?? "",
    monthly: formatCurrencyValue(row.price_monthly),
    yearly: formatCurrencyValue(row.price_yearly),
    trial: row.trial_days ?? "",
    subs: numericCount(row.subscription_count),
    accounts: numericCount(row.subscribed_account_count),
    admin: numericCount(row.admin_assigned_count),
    licenses: numericCount(row.site_license_count),
    active: row.disabled ? "no" : "yes",
  };
}

function sortMembershipTierRows(
  rows: MembershipTierRow[],
): MembershipTierRow[] {
  return [...rows].sort((a, b) => {
    const priorityDelta = Number(b.priority ?? 0) - Number(a.priority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    return `${a.id ?? ""}`.localeCompare(`${b.id ?? ""}`);
  });
}

function formatMembershipTiersPrometheus(rows: MembershipTierRow[]): string {
  const lines = [
    "# HELP cocalc_membership_tier_subscriptions Active membership subscription records by tier.",
    "# TYPE cocalc_membership_tier_subscriptions gauge",
  ];
  for (const row of rows) {
    const labels = prometheusLabels({
      tier_id: row.id ?? "",
      label: row.label ?? "",
    });
    lines.push(
      `cocalc_membership_tier_subscriptions{${labels}} ${numericCount(row.subscription_count)}`,
    );
  }
  lines.push(
    "# HELP cocalc_membership_tier_subscribed_accounts Distinct accounts with active membership subscriptions by tier.",
    "# TYPE cocalc_membership_tier_subscribed_accounts gauge",
  );
  for (const row of rows) {
    const labels = prometheusLabels({
      tier_id: row.id ?? "",
      label: row.label ?? "",
    });
    lines.push(
      `cocalc_membership_tier_subscribed_accounts{${labels}} ${numericCount(row.subscribed_account_count)}`,
    );
  }
  lines.push(
    "# HELP cocalc_membership_tier_admin_assigned Active admin-assigned memberships by tier.",
    "# TYPE cocalc_membership_tier_admin_assigned gauge",
  );
  for (const row of rows) {
    const labels = prometheusLabels({
      tier_id: row.id ?? "",
      label: row.label ?? "",
    });
    lines.push(
      `cocalc_membership_tier_admin_assigned{${labels}} ${numericCount(row.admin_assigned_count)}`,
    );
  }
  lines.push(
    "# HELP cocalc_membership_tier_site_licenses Active site licenses with at least one pool using the tier.",
    "# TYPE cocalc_membership_tier_site_licenses gauge",
  );
  for (const row of rows) {
    const labels = prometheusLabels({
      tier_id: row.id ?? "",
      label: row.label ?? "",
    });
    lines.push(
      `cocalc_membership_tier_site_licenses{${labels}} ${numericCount(row.site_license_count)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parsePositiveIntegerOption({
  name,
  value,
  fallback,
  max,
}: {
  name: string;
  value?: string;
  fallback: number;
  max: number;
}): number {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.min(parsed, max);
}

function prometheusLabelValue(value: unknown): string {
  return `${value ?? ""}`
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

function prometheusLabels(labels: Record<string, unknown>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${prometheusLabelValue(value)}"`)
    .join(",");
}

function formatLaunchHealthCompact(status: LaunchHealthStatus) {
  return status.checks.map((check) => ({
    level: check.level,
    check: check.label,
    summary: check.summary,
  }));
}

async function runLaunchSmokeStep(
  steps: LaunchSmokeStepResult[],
  {
    id,
    label,
    run,
  }: {
    id: string;
    label: string;
    run: () => Promise<{
      summary: string;
      details?: Record<string, unknown>;
    }>;
  },
): Promise<void> {
  const started = Date.now();
  try {
    const result = await run();
    steps.push({
      id,
      label,
      status: "succeeded",
      duration_ms: Date.now() - started,
      summary: result.summary,
      details: result.details,
    });
  } catch (err) {
    steps.push({
      id,
      label,
      status: "failed",
      duration_ms: Date.now() - started,
      summary: `${err}`,
    });
    throw err;
  }
}

function formatAcpDenialPrometheus(report: any): string {
  const lines = [
    "# HELP cocalc_acp_admission_denials_window_total ACP admission denials in the selected recent time window.",
    "# TYPE cocalc_acp_admission_denials_window_total gauge",
  ];
  const windowMinutes = report?.window_minutes ?? "";
  for (const group of report?.groups ?? []) {
    const labels = prometheusLabels({
      bay_id: group.bay_id ?? "",
      account_id: group.account_id ?? "",
      project_id: group.project_id ?? "",
      limit: group.limit ?? "unknown",
      source: group.source ?? "unknown",
      window_minutes: windowMinutes,
    });
    lines.push(
      `cocalc_acp_admission_denials_window_total{${labels}} ${Number(group.count) || 0}`,
    );
  }
  lines.push(
    "# HELP cocalc_acp_admission_denials_max_current Maximum observed current usage in the selected recent time window.",
    "# TYPE cocalc_acp_admission_denials_max_current gauge",
  );
  for (const group of report?.groups ?? []) {
    const labels = prometheusLabels({
      bay_id: group.bay_id ?? "",
      account_id: group.account_id ?? "",
      project_id: group.project_id ?? "",
      limit: group.limit ?? "unknown",
      source: group.source ?? "unknown",
      window_minutes: windowMinutes,
    });
    lines.push(
      `cocalc_acp_admission_denials_max_current{${labels}} ${Number(group.max_current) || 0}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatServiceDenialPrometheus(report: any): string {
  const lines = [
    "# HELP cocalc_service_admission_denials_window_total Service admission denials in the selected recent time window.",
    "# TYPE cocalc_service_admission_denials_window_total gauge",
  ];
  const windowMinutes = report?.window_minutes ?? "";
  for (const group of report?.groups ?? []) {
    const labels = prometheusLabels({
      bay_id: group.bay_id ?? "",
      host_id: group.host_id ?? "",
      account_id: group.account_id ?? "",
      project_id: group.project_id ?? "",
      surface: group.surface ?? "unknown",
      limit: group.limit ?? "unknown",
      source: group.source ?? "unknown",
      window_minutes: windowMinutes,
    });
    lines.push(
      `cocalc_service_admission_denials_window_total{${labels}} ${Number(group.count) || 0}`,
    );
  }
  lines.push(
    "# HELP cocalc_service_admission_denials_max_current Maximum observed current usage in the selected recent time window.",
    "# TYPE cocalc_service_admission_denials_max_current gauge",
  );
  for (const group of report?.groups ?? []) {
    const labels = prometheusLabels({
      bay_id: group.bay_id ?? "",
      host_id: group.host_id ?? "",
      account_id: group.account_id ?? "",
      project_id: group.project_id ?? "",
      surface: group.surface ?? "unknown",
      limit: group.limit ?? "unknown",
      source: group.source ?? "unknown",
      window_minutes: windowMinutes,
    });
    lines.push(
      `cocalc_service_admission_denials_max_current{${labels}} ${Number(group.max_current) || 0}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatRootfsQuotaPrometheus(report: any): string {
  const lines = [
    "# HELP cocalc_rootfs_quota_usage_count Active RootFS image count by account.",
    "# TYPE cocalc_rootfs_quota_usage_count gauge",
  ];
  for (const row of report?.top_users ?? []) {
    const labels = prometheusLabels({
      bay_id: row.bay_id ?? "",
      account_id: row.account_id ?? "",
    });
    lines.push(
      `cocalc_rootfs_quota_usage_count{${labels}} ${Number(row.count) || 0}`,
    );
  }
  lines.push(
    "# HELP cocalc_rootfs_quota_usage_total_storage_bytes Active RootFS storage bytes by account.",
    "# TYPE cocalc_rootfs_quota_usage_total_storage_bytes gauge",
  );
  for (const row of report?.top_users ?? []) {
    const labels = prometheusLabels({
      bay_id: row.bay_id ?? "",
      account_id: row.account_id ?? "",
    });
    lines.push(
      `cocalc_rootfs_quota_usage_total_storage_bytes{${labels}} ${Number(row.total_storage_bytes) || 0}`,
    );
  }
  lines.push(
    "# HELP cocalc_rootfs_quota_near_limit_ratio RootFS quota usage ratio for accounts at or above the configured near-limit threshold.",
    "# TYPE cocalc_rootfs_quota_near_limit_ratio gauge",
  );
  for (const row of report?.near_limit_users ?? []) {
    for (const [limit, value] of [
      ["rootfs_count", row.count_ratio],
      ["rootfs_total_storage_gb", row.total_storage_ratio],
      ["rootfs_max_storage_gb", row.max_rootfs_ratio],
    ]) {
      const ratio = Number(value);
      if (!Number.isFinite(ratio)) continue;
      const labels = prometheusLabels({
        bay_id: row.bay_id ?? "",
        account_id: row.account_id ?? "",
        limit,
        near_percent: report?.near_percent ?? "",
      });
      lines.push(`cocalc_rootfs_quota_near_limit_ratio{${labels}} ${ratio}`);
    }
  }
  lines.push(
    "# HELP cocalc_rootfs_quota_denials_window_total RootFS quota denials in the selected recent time window.",
    "# TYPE cocalc_rootfs_quota_denials_window_total gauge",
  );
  for (const group of report?.denials ?? []) {
    const labels = prometheusLabels({
      bay_id: group.bay_id ?? "",
      account_id: group.account_id ?? "",
      limit: group.limit ?? "unknown",
      operation: group.operation ?? "unknown",
      reason: group.reason ?? "",
      window_minutes: report?.window_minutes ?? "",
    });
    lines.push(
      `cocalc_rootfs_quota_denials_window_total{${labels}} ${Number(group.count) || 0}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function registerAdminCommand(
  program: Command,
  deps: AdminCommandDeps,
): Command {
  const { withContext, resolveAccountByIdentifier, isValidUUID, waitForLro } =
    deps;

  const admin = program.command("admin").description("site admin operations");
  const adminUser = admin.command("user").description("admin user management");
  const adminMessage = admin
    .command("message")
    .description("admin system message operations");
  const adminEntitlementOverride = admin
    .command("entitlement-override")
    .description("admin account entitlement override operations")
    .addHelpText("after", ENTITLEMENT_OVERRIDE_HELP);
  const adminMembershipAssignment = admin
    .command("membership-assignment")
    .description("admin-assigned membership operations");
  const adminPurchase = admin
    .command("purchase")
    .description("audited admin-assisted purchase operations");
  const adminMasterKey = admin
    .command("master-key")
    .description("local site master key lifecycle operations");
  const adminData = admin
    .command("data")
    .description("Admin Data Explorer shared views and datasets");
  const adminDataViews = adminData
    .command("views")
    .description("Admin Data Explorer shared view registry");
  const adminDataSql = adminData
    .command("sql")
    .description("Admin Data Explorer restricted SQL");
  const adminDataAudit = adminData
    .command("audit")
    .description("Admin Data Explorer audit trail");
  const adminDb = admin
    .command("db")
    .description("audited admin database diagnostics and read-only SQL");
  const adminHost = admin
    .command("host")
    .description("audited project-host diagnostics");
  const adminSupport = admin
    .command("support")
    .description("audited Zendesk support diagnostics and operator actions")
    .addHelpText(
      "after",
      `
Human-in-the-loop workflow:
  1. Run update, reply, note, merge, or spam without --commit and review the plan.
  2. Re-run with the returned updated_at value(s) and --commit.
  3. Mutations require fresh admin authentication and reject stale tickets.

Reply example:
  cocalc admin support reply 20437 --file /tmp/reply.txt --reason "approved response"
  cocalc admin support reply 20437 --file /tmp/reply.txt --status solved \\
    --expected-updated-at <timestamp-from-plan> --reason "approved response" --commit

Merge comments are private unless their corresponding --*-comment-public flag is set.
`,
    );
  const adminCrashes = admin
    .command("crashes")
    .description("audited frontend crash report diagnostics and triage");
  const adminSettings = admin
    .command("settings")
    .description("admin site settings inspection");

  registerReceivablesCommand(admin, {
    withContext,
    resolveAccountByIdentifier,
    isValidUUID,
  });
  registerCrmCommand(admin, {
    withContext,
    resolveAccountByIdentifier,
    isValidUUID,
  });

  async function resolveTargetAccountId(
    ctx: any,
    user: string,
  ): Promise<string> {
    const identifier = `${user ?? ""}`.trim();
    if (!identifier) {
      throw new Error("user identifier must be non-empty");
    }
    const resolved = isValidUUID(identifier)
      ? { account_id: identifier }
      : await resolveAccountByIdentifier(ctx, identifier);
    const userAccountId = `${resolved?.account_id ?? ""}`.trim();
    if (!userAccountId) {
      throw new Error(`unable to resolve account for '${identifier}'`);
    }
    return userAccountId;
  }

  async function requireAssignableMembershipTier(
    ctx: any,
    tier: string,
  ): Promise<string> {
    const membershipClass = `${tier ?? ""}`.trim();
    if (!membershipClass) {
      throw new Error("--tier must be non-empty");
    }
    const result = (await ctx.hub.db.userQuery({
      query: {
        membership_tiers: {
          id: "*",
          label: null,
          disabled: null,
        },
      },
      options: [],
    })) as { membership_tiers?: MembershipTierRow[] };
    const tiers = result.membership_tiers ?? [];
    const selected = tiers.find(
      (candidate) => candidate.id === membershipClass,
    );
    if (!selected) {
      const available = tiers
        .filter((candidate) => candidate.id && !candidate.disabled)
        .map((candidate) => candidate.id)
        .sort()
        .join(", ");
      throw new Error(
        `unknown membership tier '${membershipClass}'${
          available ? `; enabled tiers: ${available}` : ""
        }`,
      );
    }
    if (selected.disabled) {
      throw new Error(`membership tier '${membershipClass}' is disabled`);
    }
    return membershipClass;
  }

  adminPurchase
    .command("membership-package <user>")
    .description(
      "preview or create a custom-price membership package for an account",
    )
    .requiredOption("--kind <kind>", "package kind: course, team, or site")
    .requiredOption("--membership-class <class>", "membership class")
    .requiredOption("--seat-count <n>", "number of package seats")
    .requiredOption("--price <usd>", "custom total price in USD")
    .requiredOption("--source <source>", "card, credit, or free")
    .requiredOption("--reason <text>", "operator audit reason")
    .option("--interval <interval>", "month or year")
    .option("--course-project <uuid>", "course project UUID")
    .option("--starts-at <iso>", "explicit package start time")
    .option("--expires-at <iso>", "explicit package expiry time")
    .option("--metadata-json <json>", "package metadata JSON object")
    .option("--pricing-note <text>", "internal custom-pricing explanation")
    .option(
      "--idempotency-key <key>",
      "stable retry key; derived from the reviewed request by default",
    )
    .option("--commit", "create the package and purchase", false)
    .action(async (user: string, opts: any, command: Command) => {
      await withContext(
        command,
        "admin purchase membership-package",
        async (ctx) => {
          const user_account_id = await resolveTargetAccountId(ctx, user);
          const kind = parseAdminPackageKind(opts.kind);
          const membership_class = `${opts.membershipClass ?? ""}`.trim();
          if (!membership_class) {
            throw new Error("--membership-class must be non-empty");
          }
          const seat_count = parseAdminPackagePositiveInteger(
            opts.seatCount,
            "--seat-count",
          );
          const price = parseAdminPackagePrice(opts.price);
          const source = `${opts.source ?? ""}`.trim();
          if (source !== "card" && source !== "credit" && source !== "free") {
            throw new Error("--source must be card, credit, or free");
          }
          const reason = `${opts.reason ?? ""}`.trim();
          if (!reason) throw new Error("--reason must be non-empty");
          const interval = `${opts.interval ?? ""}`.trim() || undefined;
          if (interval && interval !== "month" && interval !== "year") {
            throw new Error("--interval must be month or year");
          }
          const course_project_id =
            `${opts.courseProject ?? ""}`.trim() || undefined;
          if (course_project_id && !isValidUUID(course_project_id)) {
            throw new Error("--course-project must be a project UUID");
          }
          if (kind === "course" && !course_project_id) {
            throw new Error("--course-project is required for course packages");
          }
          const starts_at = opts.startsAt
            ? parseAdminPackageDate(opts.startsAt, "--starts-at")
            : undefined;
          const expires_at = opts.expiresAt
            ? parseAdminPackageDate(opts.expiresAt, "--expires-at")
            : undefined;
          const metadata = parseAdminPackageMetadata(opts.metadataJson);
          const product = {
            type: "membership-package" as const,
            kind,
            membership_class,
            seat_count,
            interval: interval as "month" | "year" | undefined,
            course_project_id,
            starts_at,
            expires_at,
            metadata,
          };
          const quote = await ctx.hub.purchases.getMembershipPackageQuote({
            account_id: ctx.accountId,
            kind,
            membership_class,
            seat_count,
            interval,
            course_project_id,
            starts_at,
            expires_at,
            metadata: metadata ?? null,
          });
          const idempotency_key =
            `${opts.idempotencyKey ?? ""}`.trim() ||
            createHash("sha256")
              .update(
                JSON.stringify({
                  user_account_id,
                  product,
                  price,
                  source,
                  reason,
                  pricing_note: `${opts.pricingNote ?? ""}`.trim() || null,
                }),
              )
              .digest("hex")
              .slice(0, 32);
          const preview = {
            dry_run: !opts.commit,
            user_account_id,
            product,
            source,
            custom_price: price,
            standard_price: quote.total_price,
            discount: quote.total_price - price,
            starts_at: starts_at ?? quote.starts_at,
            expires_at: expires_at ?? quote.expires_at,
            idempotency_key,
            reason,
          };
          if (!opts.commit) return preview;
          return {
            ...preview,
            dry_run: false,
            result:
              await ctx.hub.purchases.adminCreateMembershipPackagePurchase({
                account_id: ctx.accountId,
                user_account_id,
                product,
                price,
                source,
                reason,
                idempotency_key,
                pricing_note: `${opts.pricingNote ?? ""}`.trim() || undefined,
              }),
          };
        },
      );
    });

  function adminSupportListOptions(command: Command): Command {
    return command
      .option("--since-minutes <n>", "ticket creation lookback", "1440")
      .option("--limit <n>", "maximum ticket count", "50")
      .option(
        "--status <statuses>",
        "comma-separated ticket statuses",
        "new,open,pending,hold",
      )
      .option("--max-bytes <n>", "maximum response bytes", "262144")
      .requiredOption("--reason <reason>", "human-readable audit reason");
  }

  function adminSupportListRequest(opts: {
    sinceMinutes?: string;
    limit?: string;
    status?: string;
    maxBytes?: string;
    reason?: string;
  }) {
    return {
      since_minutes: parsePositiveIntegerOption({
        name: "--since-minutes",
        value: opts.sinceMinutes,
        fallback: 24 * 60,
        max: 7 * 24 * 60,
      }),
      limit: parsePositiveIntegerOption({
        name: "--limit",
        value: opts.limit,
        fallback: 50,
        max: 100,
      }),
      statuses: parseAdminSupportStatuses(
        opts.status ?? "new,open,pending,hold",
      ),
      max_bytes: parsePositiveIntegerOption({
        name: "--max-bytes",
        value: opts.maxBytes,
        fallback: 256 * 1024,
        max: 1024 * 1024,
      }),
      reason: opts.reason,
    };
  }

  function parseSupportTags(value: string | undefined): string[] | undefined {
    if (value == null) return undefined;
    return [
      ...new Set(
        value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
  }

  function parseSupportStatus(
    value: string | undefined,
  ): AdminSupportMutableTicketStatus | undefined {
    if (value == null) return undefined;
    if (!ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.includes(value as any)) {
      throw new Error(
        `--status must be one of ${ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.join(", ")}`,
      );
    }
    return value as AdminSupportMutableTicketStatus;
  }

  function parseSupportPriority(
    value: string | undefined,
  ): AdminSupportTicketPriority | undefined {
    if (value == null) return undefined;
    if (!ADMIN_SUPPORT_TICKET_PRIORITIES.includes(value as any)) {
      throw new Error(
        `--priority must be one of ${ADMIN_SUPPORT_TICKET_PRIORITIES.join(", ")}`,
      );
    }
    return value as AdminSupportTicketPriority;
  }

  async function readSupportComment({
    text,
    file,
    textOption,
    fileOption,
  }: {
    text?: string;
    file?: string;
    textOption: string;
    fileOption: string;
  }): Promise<string | undefined> {
    if (text != null && file != null) {
      throw new Error(`specify only one of ${textOption} or ${fileOption}`);
    }
    const value = file != null ? await readFile(file, "utf8") : text;
    if (value == null) return undefined;
    if (text != null && /(?:\\r\\n|\\n)/.test(value)) {
      throw new Error(
        `${textOption} contains a literal \\n escape; use ${fileOption} for multiline text`,
      );
    }
    const normalized = value.replace(/\r\n/g, "\n").trim();
    if (!normalized) throw new Error("support comment must be non-empty");
    return normalized;
  }

  function supportIdempotencyKey(
    operation: "update" | "merge" | "spam",
    request: Record<string, unknown>,
    explicit: string | undefined,
  ): string {
    if (explicit?.trim()) return explicit.trim();
    const hash = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(request).filter(
              ([key]) => key !== "reason" && key !== "idempotency_key",
            ),
          ),
        ),
      )
      .digest("hex")
      .slice(0, 40);
    return `support-${operation}-${hash}`;
  }

  function adminSupportUpdateOptions(command: Command): Command {
    return command
      .option(
        "--public-reply <text>",
        "single-line public reply body; use --public-reply-file for multiline text",
      )
      .option("--public-reply-file <path>", "read public reply from a file")
      .option(
        "--private-note <text>",
        "single-line private note body; use --private-note-file for multiline text",
      )
      .option("--private-note-file <path>", "read private note from a file")
      .option(
        "--status <status>",
        `new ticket status (${ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.join(", ")})`,
      )
      .option(
        "--priority <priority>",
        `new priority (${ADMIN_SUPPORT_TICKET_PRIORITIES.join(", ")})`,
      )
      .option("--clear-priority", "clear the ticket priority")
      .option("--assignee-id <id>", "assign to this Zendesk user id")
      .option("--unassign", "clear the ticket assignee")
      .option("--add-tags <tags>", "comma-separated tags to add")
      .option("--remove-tags <tags>", "comma-separated tags to remove")
      .option(
        "--expected-updated-at <timestamp>",
        "exact updated_at reviewed during dry-run; required with --commit",
      )
      .option(
        "--idempotency-key <key>",
        "stable logical request key; generated from the approved payload by default",
      )
      .option(
        "--commit",
        "apply the update; otherwise only show a dry-run",
        false,
      )
      .requiredOption("--reason <reason>", "human-readable audit reason");
  }

  async function adminSupportUpdateRequest(opts: any) {
    if (opts.clearPriority && opts.priority != null) {
      throw new Error("specify only one of --priority or --clear-priority");
    }
    if (opts.unassign && opts.assigneeId != null) {
      throw new Error("specify only one of --assignee-id or --unassign");
    }
    const publicReply = await readSupportComment({
      text: opts.publicReply,
      file: opts.publicReplyFile,
      textOption: "--public-reply",
      fileOption: "--public-reply-file",
    });
    const privateNote = await readSupportComment({
      text: opts.privateNote,
      file: opts.privateNoteFile,
      textOption: "--private-note",
      fileOption: "--private-note-file",
    });
    if (publicReply && privateNote) {
      throw new Error("specify only a public reply or a private note");
    }
    let assigneeId: number | null | undefined;
    if (opts.unassign) {
      assigneeId = null;
    } else if (opts.assigneeId != null) {
      assigneeId = parsePositiveIntegerOption({
        name: "--assignee-id",
        value: opts.assigneeId,
        fallback: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
    }
    const changes: AdminSupportUpdateChanges = {
      ...(publicReply ? { public_reply: publicReply } : {}),
      ...(privateNote ? { private_note: privateNote } : {}),
      ...(opts.status != null
        ? { status: parseSupportStatus(opts.status) }
        : {}),
      ...(opts.clearPriority
        ? { priority: null }
        : opts.priority != null
          ? { priority: parseSupportPriority(opts.priority) }
          : {}),
      ...(assigneeId !== undefined ? { assignee_id: assigneeId } : {}),
      add_tags: parseSupportTags(opts.addTags),
      remove_tags: parseSupportTags(opts.removeTags),
    };
    return changes;
  }

  async function executeAdminSupportUpdate({
    ctx,
    ticketId,
    opts,
    changes,
  }: {
    ctx: any;
    ticketId: number;
    opts: {
      expectedUpdatedAt?: string;
      idempotencyKey?: string;
      commit?: boolean;
      reason?: string;
    };
    changes: AdminSupportUpdateChanges;
  }) {
    const request = {
      ticket_id: ticketId,
      ...changes,
      expected_updated_at: opts.expectedUpdatedAt,
      reason: opts.reason,
    };
    if (!opts.commit) {
      return await ctx.hub.adminSupport.planUpdate(request);
    }
    if (!opts.expectedUpdatedAt?.trim()) {
      throw new Error(
        "--expected-updated-at is required with --commit; use the value returned by the dry-run",
      );
    }
    return await ctx.hub.adminSupport.update({
      ...request,
      expected_updated_at: opts.expectedUpdatedAt,
      timeout: 60_000,
      idempotency_key: supportIdempotencyKey(
        "update",
        request,
        opts.idempotencyKey,
      ),
    });
  }

  function adminSupportSimpleMutationOptions(command: Command): Command {
    return command
      .requiredOption("--file <path>", "read comment body from this file")
      .option(
        "--status <status>",
        `new ticket status (${ADMIN_SUPPORT_MUTABLE_TICKET_STATUSES.join(", ")})`,
      )
      .option(
        "--expected-updated-at <timestamp>",
        "exact updated_at reviewed during dry-run; required with --commit",
      )
      .option("--idempotency-key <key>", "stable logical request key")
      .option(
        "--commit",
        "apply the update; otherwise only show a dry-run",
        false,
      )
      .requiredOption("--reason <reason>", "human-readable audit reason");
  }

  function adminCrashListOptions(command: Command): Command {
    return command
      .option("--since-minutes <n>", "crash report lookback", "1440")
      .option("--limit <n>", "maximum report count", "200")
      .option("--max-bytes <n>", "maximum response bytes", "524288")
      .option("--bay <bay-id>", "query only this bay; defaults to all bays")
      .option("--status <status>", "open, solved, or all", "open")
      .requiredOption("--reason <reason>", "human-readable audit reason");
  }

  function adminCrashListRequest(opts: {
    sinceMinutes?: string;
    limit?: string;
    maxBytes?: string;
    bay?: string;
    status?: string;
    reason?: string;
  }) {
    return {
      since_minutes: parsePositiveIntegerOption({
        name: "--since-minutes",
        value: opts.sinceMinutes,
        fallback: 24 * 60,
        max: 30 * 24 * 60,
      }),
      limit: parsePositiveIntegerOption({
        name: "--limit",
        value: opts.limit,
        fallback: 200,
        max: 2000,
      }),
      max_bytes: parsePositiveIntegerOption({
        name: "--max-bytes",
        value: opts.maxBytes,
        fallback: 512 * 1024,
        max: 4 * 1024 * 1024,
      }),
      bay_id: opts.bay?.trim() || undefined,
      status: parseAdminCrashStatus(opts.status),
      reason: opts.reason,
    };
  }

  function adminDbCommonOptions(command: Command): Command {
    return command
      .option("--bay <bay-id>", "target bay id; defaults to the current bay")
      .option("--limit <n>", "server-enforced max rows", "200")
      .option("--timeout-ms <n>", "server-side statement timeout", "15000")
      .option("--lock-timeout-ms <n>", "server-side lock timeout", "1000")
      .option("--max-bytes <n>", "max serialized response bytes", "2097152");
  }

  function adminDbRequestOptions(opts: {
    bay?: string;
    limit?: string;
    timeoutMs?: string;
    lockTimeoutMs?: string;
    maxBytes?: string;
  }) {
    return {
      bay_id: opts.bay?.trim() || undefined,
      limit: parsePositiveIntegerOption({
        name: "--limit",
        value: opts.limit,
        fallback: 200,
        max: 5000,
      }),
      statement_timeout_ms: parsePositiveIntegerOption({
        name: "--timeout-ms",
        value: opts.timeoutMs,
        fallback: 15000,
        max: 120000,
      }),
      lock_timeout_ms: parsePositiveIntegerOption({
        name: "--lock-timeout-ms",
        value: opts.lockTimeoutMs,
        fallback: 1000,
        max: 10000,
      }),
      max_bytes: parsePositiveIntegerOption({
        name: "--max-bytes",
        value: opts.maxBytes,
        fallback: 2 * 1024 * 1024,
        max: 10 * 1024 * 1024,
      }),
    };
  }

  async function runAdminDbDiagnostic({
    ctx,
    diagnostic,
    opts,
    params,
  }: {
    ctx: any;
    diagnostic: AdminDbDiagnostic;
    opts: any;
    params?: Record<string, unknown>;
  }) {
    return await ctx.hub.adminDb.diagnostic({
      ...adminDbRequestOptions(opts),
      diagnostic,
      params,
    });
  }

  function adminHostLogRequestOptions(opts: {
    tail?: string;
    maxBytes?: string;
  }) {
    return {
      lines: parsePositiveIntegerOption({
        name: "--tail",
        value: opts.tail,
        fallback: 200,
        max: 5000,
      }),
      max_bytes: parsePositiveIntegerOption({
        name: "--max-bytes",
        value: opts.maxBytes,
        fallback: 512 * 1024,
        max: 2 * 1024 * 1024,
      }),
    };
  }

  admin
    .command("search <query>")
    .description(
      "search users by partial name, email, account_id, or project_id (admin-only)",
    )
    .option("--limit <n>", "max rows (default 20)")
    .option("--only-email", "search only by exact email matches")
    .action(
      async (
        query: string,
        opts: { limit?: string; onlyEmail?: boolean },
        command: Command,
      ) => {
        await withContext(command, "admin search", async (ctx) => {
          const normalizedQuery = `${query ?? ""}`.trim().toLowerCase();
          if (!normalizedQuery) {
            throw new Error("query must be non-empty");
          }

          const limit = opts.limit == null ? 20 : Number(opts.limit);
          if (
            !Number.isFinite(limit) ||
            !Number.isInteger(limit) ||
            limit <= 0
          ) {
            throw new Error("--limit must be a positive integer");
          }
          const cappedLimit = Math.min(limit, ADMIN_SEARCH_LIMIT);

          const rows = (await ctx.hub.system.userSearch({
            query: normalizedQuery,
            admin: true,
            limit: cappedLimit,
            only_email: !!opts.onlyEmail,
          })) as Array<{
            account_id: string;
            display_name?: string;
            first_name?: string;
            last_name?: string;
            name?: string;
            email_address?: string;
            last_active?: number;
            created?: number;
            banned?: boolean;
            email_address_verified?: boolean;
          }>;

          return (rows ?? []).map((row) => {
            const displayName = displayNameFromAccount(row);
            return {
              account_id: row.account_id,
              name: displayName || row.name || "",
              display_name: displayName,
              first_name: row.first_name ?? "",
              last_name: row.last_name ?? "",
              email_address: row.email_address ?? null,
              email_address_verified:
                row.email_address_verified == null
                  ? null
                  : !!row.email_address_verified,
              banned: row.banned == null ? null : !!row.banned,
              last_active: row.last_active ?? null,
              created: row.created ?? null,
            };
          });
        });
      },
    );

  adminSupportListOptions(adminSupport.command("list"))
    .description("list recent redacted Zendesk tickets")
    .action(async (opts, command: Command) => {
      await withContext(command, "admin support list", async (ctx) => {
        return await ctx.hub.adminSupport.list(adminSupportListRequest(opts));
      });
    });

  adminSupport
    .command("conventions")
    .description("show the human-in-the-loop Zendesk support conventions")
    .action(async (_opts, command: Command) => {
      await withContext(command, "admin support conventions", async () => {
        return ADMIN_SUPPORT_CONVENTIONS;
      });
    });

  adminSupport
    .command("show <ticket-id>")
    .description(
      "show one redacted ticket conversation with validated image references",
    )
    .option("--max-comments <n>", "maximum recent comments", "50")
    .option("--max-bytes <n>", "maximum response bytes", "262144")
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(
      async (
        ticketId: string,
        opts: {
          maxComments?: string;
          maxBytes?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin support show", async (ctx) => {
          return await ctx.hub.adminSupport.show({
            ticket_id: parsePositiveIntegerOption({
              name: "ticket-id",
              value: ticketId,
              fallback: 0,
              max: Number.MAX_SAFE_INTEGER,
            }),
            max_comments: parsePositiveIntegerOption({
              name: "--max-comments",
              value: opts.maxComments,
              fallback: 50,
              max: 100,
            }),
            max_bytes: parsePositiveIntegerOption({
              name: "--max-bytes",
              value: opts.maxBytes,
              fallback: 256 * 1024,
              max: 1024 * 1024,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  adminSupport
    .command("image <ticket-id> <attachment-id>")
    .description(
      "download one validated Zendesk image attachment without exposing its URL",
    )
    .option("--output <path>", "output file; defaults to a safe generated name")
    .option("--max-bytes <n>", "maximum downloaded image bytes", "8388608")
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(
      async (
        ticketId: string,
        attachmentId: string,
        opts: {
          output?: string;
          maxBytes?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin support image", async (ctx) => {
          const result = await ctx.hub.adminSupport.getImage({
            ticket_id: parsePositiveIntegerOption({
              name: "ticket-id",
              value: ticketId,
              fallback: 0,
              max: Number.MAX_SAFE_INTEGER,
            }),
            attachment_id: parsePositiveIntegerOption({
              name: "attachment-id",
              value: attachmentId,
              fallback: 0,
              max: Number.MAX_SAFE_INTEGER,
            }),
            max_bytes: parsePositiveIntegerOption({
              name: "--max-bytes",
              value: opts.maxBytes,
              fallback: 8 * 1024 * 1024,
              max: 20 * 1024 * 1024,
            }),
            reason: opts.reason,
          });
          const data = Buffer.from(result.data_base64, "base64");
          const digest = createHash("sha256").update(data).digest("hex");
          if (data.length !== result.size || digest !== result.sha256) {
            throw new Error("downloaded support image failed integrity checks");
          }
          const output = opts.output?.trim() || result.filename;
          await writeFile(output, data);
          const { data_base64: _dataBase64, ...metadata } = result;
          return { ...metadata, output };
        });
      },
    );

  adminSupportListOptions(adminSupport.command("triage"))
    .description("group recent tickets by deterministic operational signals")
    .action(async (opts, command: Command) => {
      await withContext(command, "admin support triage", async (ctx) => {
        return await ctx.hub.adminSupport.triage(adminSupportListRequest(opts));
      });
    });

  adminSupport
    .command("search")
    .description("run a bounded redacted Zendesk ticket search")
    .requiredOption("--query <query>", "Zendesk search expression")
    .option("--limit <n>", "maximum ticket count", "50")
    .option("--max-bytes <n>", "maximum response bytes", "262144")
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(async (opts, command: Command) => {
      await withContext(command, "admin support search", async (ctx) => {
        return await ctx.hub.adminSupport.search({
          query: opts.query,
          limit: parsePositiveIntegerOption({
            name: "--limit",
            value: opts.limit,
            fallback: 50,
            max: 100,
          }),
          max_bytes: parsePositiveIntegerOption({
            name: "--max-bytes",
            value: opts.maxBytes,
            fallback: 256 * 1024,
            max: 1024 * 1024,
          }),
          reason: opts.reason,
        });
      });
    });

  adminSupportUpdateOptions(adminSupport.command("update <ticket-id>"))
    .description(
      "plan or atomically apply a Zendesk reply, note, status, assignment, priority, or tag update",
    )
    .action(async (ticketId: string, opts: any, command: Command) => {
      await withContext(command, "admin support update", async (ctx) => {
        const id = parsePositiveIntegerOption({
          name: "ticket-id",
          value: ticketId,
          fallback: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        return await executeAdminSupportUpdate({
          ctx,
          ticketId: id,
          opts,
          changes: await adminSupportUpdateRequest(opts),
        });
      });
    });

  adminSupportSimpleMutationOptions(adminSupport.command("reply <ticket-id>"))
    .description("plan or send a public Zendesk reply")
    .action(async (ticketId: string, opts: any, command: Command) => {
      await withContext(command, "admin support reply", async (ctx) => {
        const body = await readSupportComment({
          file: opts.file,
          textOption: "--reply",
          fileOption: "--file",
        });
        if (!body) throw new Error("public reply file must be non-empty");
        return await executeAdminSupportUpdate({
          ctx,
          ticketId: parsePositiveIntegerOption({
            name: "ticket-id",
            value: ticketId,
            fallback: 0,
            max: Number.MAX_SAFE_INTEGER,
          }),
          opts,
          changes: {
            public_reply: body,
            ...(opts.status != null
              ? { status: parseSupportStatus(opts.status) }
              : {}),
          },
        });
      });
    });

  adminSupportSimpleMutationOptions(adminSupport.command("note <ticket-id>"))
    .description("plan or add a private Zendesk note")
    .action(async (ticketId: string, opts: any, command: Command) => {
      await withContext(command, "admin support note", async (ctx) => {
        const body = await readSupportComment({
          file: opts.file,
          textOption: "--note",
          fileOption: "--file",
        });
        if (!body) throw new Error("private note file must be non-empty");
        return await executeAdminSupportUpdate({
          ctx,
          ticketId: parsePositiveIntegerOption({
            name: "ticket-id",
            value: ticketId,
            fallback: 0,
            max: Number.MAX_SAFE_INTEGER,
          }),
          opts,
          changes: {
            private_note: body,
            ...(opts.status != null
              ? { status: parseSupportStatus(opts.status) }
              : {}),
          },
        });
      });
    });

  adminSupport
    .command("merge")
    .description("plan or merge one Zendesk ticket into another")
    .requiredOption("--target <ticket-id>", "ticket that remains after merge")
    .requiredOption("--source <ticket-id>", "ticket merged into the target")
    .option("--target-comment <text>", "comment added to the target ticket")
    .option(
      "--target-comment-file <path>",
      "read the target comment from a file",
    )
    .option("--source-comment <text>", "comment added to the source ticket")
    .option(
      "--source-comment-file <path>",
      "read the source comment from a file",
    )
    .option("--target-comment-public", "make the target comment public", false)
    .option("--source-comment-public", "make the source comment public", false)
    .option(
      "--target-expected-updated-at <timestamp>",
      "reviewed target updated_at; required with --commit",
    )
    .option(
      "--source-expected-updated-at <timestamp>",
      "reviewed source updated_at; required with --commit",
    )
    .option("--idempotency-key <key>", "stable logical request key")
    .option(
      "--commit",
      "perform the merge; otherwise only show a dry-run",
      false,
    )
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(async (opts: any, command: Command) => {
      await withContext(command, "admin support merge", async (ctx) => {
        const targetTicketId = parsePositiveIntegerOption({
          name: "--target",
          value: opts.target,
          fallback: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        const sourceTicketId = parsePositiveIntegerOption({
          name: "--source",
          value: opts.source,
          fallback: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        const request = {
          target_ticket_id: targetTicketId,
          source_ticket_id: sourceTicketId,
          target_comment: await readSupportComment({
            text: opts.targetComment,
            file: opts.targetCommentFile,
            textOption: "--target-comment",
            fileOption: "--target-comment-file",
          }),
          source_comment: await readSupportComment({
            text: opts.sourceComment,
            file: opts.sourceCommentFile,
            textOption: "--source-comment",
            fileOption: "--source-comment-file",
          }),
          target_comment_public: opts.targetCommentPublic === true,
          source_comment_public: opts.sourceCommentPublic === true,
          target_expected_updated_at: opts.targetExpectedUpdatedAt,
          source_expected_updated_at: opts.sourceExpectedUpdatedAt,
          reason: opts.reason,
        };
        if (!opts.commit) {
          return await ctx.hub.adminSupport.planMerge(request);
        }
        if (
          !opts.targetExpectedUpdatedAt?.trim() ||
          !opts.sourceExpectedUpdatedAt?.trim()
        ) {
          throw new Error(
            "both --target-expected-updated-at and --source-expected-updated-at are required with --commit; use the dry-run values",
          );
        }
        return await ctx.hub.adminSupport.merge({
          ...request,
          target_expected_updated_at: opts.targetExpectedUpdatedAt,
          source_expected_updated_at: opts.sourceExpectedUpdatedAt,
          timeout: 120_000,
          idempotency_key: supportIdempotencyKey(
            "merge",
            request,
            opts.idempotencyKey,
          ),
        });
      });
    });

  adminSupport
    .command("spam <ticket-id>")
    .description(
      "plan or mark a Zendesk ticket as spam, with a solve-and-tag fallback",
    )
    .option(
      "--expected-updated-at <timestamp>",
      "exact updated_at reviewed during dry-run; required with --commit",
    )
    .option("--idempotency-key <key>", "stable logical request key")
    .option(
      "--commit",
      "mark as spam; otherwise only show a dry-run warning",
      false,
    )
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(async (ticketId: string, opts: any, command: Command) => {
      await withContext(command, "admin support spam", async (ctx) => {
        const id = parsePositiveIntegerOption({
          name: "ticket-id",
          value: ticketId,
          fallback: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        const request = {
          ticket_id: id,
          expected_updated_at: opts.expectedUpdatedAt,
          reason: opts.reason,
        };
        if (!opts.commit) {
          return await ctx.hub.adminSupport.planSpam(request);
        }
        if (!opts.expectedUpdatedAt?.trim()) {
          throw new Error(
            "--expected-updated-at is required with --commit; use the value returned by the dry-run",
          );
        }
        return await ctx.hub.adminSupport.spam({
          ...request,
          expected_updated_at: opts.expectedUpdatedAt,
          timeout: 60_000,
          idempotency_key: supportIdempotencyKey(
            "spam",
            request,
            opts.idempotencyKey,
          ),
        });
      });
    });

  adminCrashListOptions(adminCrashes.command("list"))
    .description("list recent redacted frontend crash reports")
    .action(async (opts, command: Command) => {
      await withContext(command, "admin crashes list", async (ctx) => {
        return await ctx.hub.adminCrashes.list(adminCrashListRequest(opts));
      });
    });

  adminCrashListOptions(adminCrashes.command("triage"))
    .description("group frontend crashes by signature and frontend build")
    .action(async (opts, command: Command) => {
      await withContext(command, "admin crashes triage", async (ctx) => {
        return await ctx.hub.adminCrashes.triage(adminCrashListRequest(opts));
      });
    });

  adminCrashes
    .command("show <report-id>")
    .description("show one redacted frontend crash report")
    .option("--bay <bay-id>", "known report bay; otherwise search all bays")
    .option("--max-bytes <n>", "maximum response bytes", "524288")
    .requiredOption("--reason <reason>", "human-readable audit reason")
    .action(
      async (
        reportId: string,
        opts: { bay?: string; maxBytes?: string; reason?: string },
        command: Command,
      ) => {
        if (!isValidUUID(reportId)) throw new Error("report-id must be a UUID");
        await withContext(command, "admin crashes show", async (ctx) => {
          return await ctx.hub.adminCrashes.show({
            report_id: reportId,
            bay_id: opts.bay?.trim() || undefined,
            max_bytes: parsePositiveIntegerOption({
              name: "--max-bytes",
              value: opts.maxBytes,
              fallback: 512 * 1024,
              max: 4 * 1024 * 1024,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  function addCrashResolutionCommand(name: "resolve" | "reopen") {
    adminCrashes
      .command(`${name} <report-id>`)
      .description(
        name === "resolve"
          ? "mark this crash signature solved for its frontend build"
          : "reopen this crash signature for its frontend build",
      )
      .requiredOption(
        "--bay <bay-id>",
        "bay containing the representative report",
      )
      .option("--note <note>", "operator resolution note")
      .requiredOption("--reason <reason>", "human-readable audit reason")
      .action(
        async (
          reportId: string,
          opts: { bay?: string; note?: string; reason?: string },
          command: Command,
        ) => {
          if (!isValidUUID(reportId))
            throw new Error("report-id must be a UUID");
          await withContext(command, `admin crashes ${name}`, async (ctx) => {
            return await ctx.hub.adminCrashes[name]({
              report_id: reportId,
              bay_id: `${opts.bay ?? ""}`.trim(),
              note: opts.note,
              reason: opts.reason,
            });
          });
        },
      );
  }

  addCrashResolutionCommand("resolve");
  addCrashResolutionCommand("reopen");

  adminHost
    .command("describe <host>")
    .description("show audited project-host operational summary")
    .option("--recent-limit <n>", "recent LRO/event rows", "10")
    .option("--no-live", "skip live project-host control RPCs")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: {
          recentLimit?: string;
          live?: boolean;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin host describe", async (ctx) => {
          return await ctx.hub.adminHost.describe({
            host,
            recent_limit: parsePositiveIntegerOption({
              name: "--recent-limit",
              value: opts.recentLimit,
              fallback: 10,
              max: 50,
            }),
            include_live: opts.live !== false,
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("events <host>")
    .description("show audited project-host incident timeline")
    .option("--since-minutes <n>", "lookback window in minutes", "1440")
    .option("--limit <n>", "max timeline events", "100")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: {
          sinceMinutes?: string;
          limit?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin host events", async (ctx) => {
          return await ctx.hub.adminHost.events({
            host,
            since_minutes: parsePositiveIntegerOption({
              name: "--since-minutes",
              value: opts.sinceMinutes,
              fallback: 24 * 60,
              max: 7 * 24 * 60,
            }),
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 100,
              max: 1000,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("top <host>")
    .description("show audited project-host resource metrics")
    .option("--window-minutes <n>", "metrics lookback window", "60")
    .option("--max-points <n>", "max history points", "60")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: {
          windowMinutes?: string;
          maxPoints?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin host top", async (ctx) => {
          return await ctx.hub.adminHost.top({
            host,
            window_minutes: parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 60,
              max: 7 * 24 * 60,
            }),
            max_points: parsePositiveIntegerOption({
              name: "--max-points",
              value: opts.maxPoints,
              fallback: 60,
              max: 240,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("abuse-filesystems <host>")
    .description(
      "show audited, bounded project tree fingerprints for abuse triage",
    )
    .option("--max-projects <n>", "max active project cgroups", "2000")
    .option(
      "--max-entries-per-project <n>",
      "max tree entries per project",
      "2000",
    )
    .option("--max-total-entries <n>", "max tree entries per host", "50000")
    .option("--max-depth <n>", "max tree depth", "4")
    .option("--timeout-ms <n>", "host-side scan deadline", "10000")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: {
          maxProjects?: string;
          maxEntriesPerProject?: string;
          maxTotalEntries?: string;
          maxDepth?: string;
          timeoutMs?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin host abuse-filesystems",
          async (ctx) => {
            return await ctx.hub.adminHost.scanAbuseFilesystems({
              host,
              max_projects: parsePositiveIntegerOption({
                name: "--max-projects",
                value: opts.maxProjects,
                fallback: 2_000,
                max: 5_000,
              }),
              max_entries_per_project: parsePositiveIntegerOption({
                name: "--max-entries-per-project",
                value: opts.maxEntriesPerProject,
                fallback: 2_000,
                max: 10_000,
              }),
              max_total_entries: parsePositiveIntegerOption({
                name: "--max-total-entries",
                value: opts.maxTotalEntries,
                fallback: 50_000,
                max: 250_000,
              }),
              max_depth: parsePositiveIntegerOption({
                name: "--max-depth",
                value: opts.maxDepth,
                fallback: 4,
                max: 8,
              }),
              timeout_ms: parsePositiveIntegerOption({
                name: "--timeout-ms",
                value: opts.timeoutMs,
                fallback: 10_000,
                max: 30_000,
              }),
              reason: opts.reason,
            });
          },
        );
      },
    );

  adminHost
    .command("abuse-processes <host>")
    .description(
      "show an audited, sanitized per-project process snapshot for abuse triage",
    )
    .option("--max-projects <n>", "max project cgroups", "2000")
    .option("--max-processes <n>", "max project processes", "10000")
    .option("--timeout-ms <n>", "host-side scan deadline", "5000")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: {
          maxProjects?: string;
          maxProcesses?: string;
          timeoutMs?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin host abuse-processes",
          async (ctx) => {
            return await ctx.hub.adminHost.scanAbuseProcesses({
              host,
              max_projects: parsePositiveIntegerOption({
                name: "--max-projects",
                value: opts.maxProjects,
                fallback: 2_000,
                max: 5_000,
              }),
              max_processes: parsePositiveIntegerOption({
                name: "--max-processes",
                value: opts.maxProcesses,
                fallback: 10_000,
                max: 50_000,
              }),
              timeout_ms: parsePositiveIntegerOption({
                name: "--timeout-ms",
                value: opts.timeoutMs,
                fallback: 5_000,
                max: 15_000,
              }),
              reason: opts.reason,
            });
          },
        );
      },
    );

  adminHost
    .command("ps <host>")
    .description("show audited project-host process snapshot")
    .option("--limit <n>", "max process rows", "50")
    .option("--sort <rss|cpu>", "sort by rss or cpu", "rss")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: { limit?: string; sort?: string; reason?: string },
        command: Command,
      ) => {
        await withContext(command, "admin host ps", async (ctx) => {
          const sort = `${opts.sort ?? "rss"}`.trim();
          if (sort !== "rss" && sort !== "cpu") {
            throw new Error("--sort must be one of: rss, cpu");
          }
          return await ctx.hub.adminHost.ps({
            host,
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 50,
              max: 500,
            }),
            sort,
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("intrusion-snapshot <host>")
    .description(
      "collect an audited, bounded host integrity and persistence snapshot",
    )
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (host: string, opts: { reason?: string }, command: Command) => {
        await withContext(
          command,
          "admin host intrusion-snapshot",
          async (ctx) => {
            return await ctx.hub.adminHost.intrusionSnapshot({
              host,
              reason: opts.reason,
              timeout: ADMIN_HOST_INTRUSION_SNAPSHOT_TIMEOUT_MS,
            });
          },
        );
      },
    );

  adminHost
    .command("net <host>")
    .description("show audited project-host network socket snapshot")
    .option("--limit <n>", "max socket rows", "100")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: { limit?: string; reason?: string },
        command: Command,
      ) => {
        await withContext(command, "admin host net", async (ctx) => {
          return await ctx.hub.adminHost.net({
            host,
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 100,
              max: 500,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("filesystem <host>")
    .description("show audited project-host filesystem snapshot")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (host: string, opts: { reason?: string }, command: Command) => {
        await withContext(command, "admin host filesystem", async (ctx) => {
          return await ctx.hub.adminHost.filesystem({
            host,
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("podman <host>")
    .description("show audited project-host podman snapshot")
    .option("--limit <n>", "max container rows", "100")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        host: string,
        opts: { limit?: string; reason?: string },
        command: Command,
      ) => {
        await withContext(command, "admin host podman", async (ctx) => {
          return await ctx.hub.adminHost.podman({
            host,
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 100,
              max: 500,
            }),
            reason: opts.reason,
          });
        });
      },
    );

  adminHost
    .command("logs")
    .description("fetch bounded, audited project-host runtime logs")
    .requiredOption("--host-id <uuid>", "target project-host id")
    .option("--tail <n>", "number of log lines", "200")
    .option(
      "--source <source>",
      `log source: ${HOST_RUNTIME_LOG_SOURCES.join(", ")}`,
    )
    .option("--grep <text>", "server-side substring filter")
    .option("--max-bytes <n>", "max response bytes", "524288")
    .option("--reason <reason>", "human-readable reason for audit")
    .action(
      async (
        opts: {
          hostId?: string;
          tail?: string;
          source?: string;
          grep?: string;
          maxBytes?: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin host logs", async (ctx) => {
          const sourceRaw = `${opts.source ?? ""}`.trim();
          if (
            sourceRaw &&
            !HOST_RUNTIME_LOG_SOURCES.includes(
              sourceRaw as HostRuntimeLogSource,
            )
          ) {
            throw new Error(
              `--source must be one of: ${HOST_RUNTIME_LOG_SOURCES.join(", ")}`,
            );
          }
          const result = await ctx.hub.adminHost.logs({
            ...adminHostLogRequestOptions(opts),
            host_id: opts.hostId,
            source: sourceRaw ? (sourceRaw as HostRuntimeLogSource) : undefined,
            grep: opts.grep,
            reason: opts.reason,
          });
          if (!ctx.globals?.json && ctx.globals?.output !== "json") {
            process.stdout.write(result.text ?? "");
            if (result.text && !result.text.endsWith("\n")) {
              process.stdout.write("\n");
            }
            return null;
          }
          return result;
        });
      },
    );

  adminSettings
    .command("get [names...]")
    .description(
      "read site settings from the seed bay without printing secret values (admin-only)",
    )
    .action(async (names: string[] | undefined, command: Command) => {
      await withContext(command, "admin settings get", async (ctx) => {
        const result = await ctx.hub.system.getSiteSettings({
          names: (names ?? []).map((name) => `${name}`.trim()).filter(Boolean),
        });
        const wide =
          ctx.globals?.json ||
          ctx.globals?.output === "json" ||
          ctx.globals?.output === "yaml";
        return wide ? result : result.settings.map(formatSiteSettingRow);
      });
    });

  adminSettings
    .command("set <name>")
    .description(
      "set one site setting from a file without exposing its value in process arguments or output (admin fresh-auth)",
    )
    .option("--value-file <path>", "read the setting value from this file")
    .option("--clear", "clear the setting")
    .action(async (name: string, options, command: Command) => {
      await withContext(command, "admin settings set", async (ctx) => {
        if (!!options.valueFile === !!options.clear) {
          throw new Error("specify exactly one of --value-file or --clear");
        }
        const value = options.clear
          ? ""
          : (await readFile(options.valueFile, "utf8")).replace(/\r?\n$/, "");
        const result = await ctx.hub.system.setSiteSettings({
          settings: [{ name: `${name}`.trim(), value }],
        });
        const failed = result?.bays?.filter(
          ({ status }) => status === "failed",
        );
        if (failed?.length) {
          throw new Error(
            failed
              .map(
                ({ bay_id, error }) => `${bay_id}: ${error ?? "sync failed"}`,
              )
              .join("; "),
          );
        }
        return {
          name: `${name}`.trim(),
          configured: value !== "",
          scope: result?.scope ?? "",
          version: result?.version ?? "",
          bays: result?.bays?.length ?? 0,
        };
      });
    });

  adminDbCommonOptions(
    adminDb
      .command("query")
      .description("run audited read-only operator SQL (admin fresh-auth)")
      .option("--sql <sql>", "SQL query text")
      .option("--file <path>", "read SQL from a file")
      .requiredOption("--reason <reason>", "human-readable reason for audit"),
  ).action(
    async (
      opts: {
        sql?: string;
        file?: string;
        reason?: string;
        bay?: string;
        limit?: string;
        timeoutMs?: string;
        lockTimeoutMs?: string;
        maxBytes?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "admin db query", async (ctx) => {
        return await ctx.hub.adminDb.query({
          ...adminDbRequestOptions(opts),
          sql: await readAdminDbSqlInput(opts),
          reason: opts.reason,
        });
      });
    },
  );

  adminDbCommonOptions(
    adminDb
      .command("host-query")
      .description(
        "run audited read-only SQL against a project-host SQLite database (admin fresh-auth)",
      )
      .requiredOption("--host-id <uuid>", "target project-host id")
      .option("--sql <sql>", "SQL query text")
      .option("--file <path>", "read SQL from a file")
      .requiredOption("--reason <reason>", "human-readable reason for audit"),
  ).action(
    async (
      opts: {
        hostId?: string;
        sql?: string;
        file?: string;
        reason?: string;
        bay?: string;
        limit?: string;
        timeoutMs?: string;
        lockTimeoutMs?: string;
        maxBytes?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "admin db host-query", async (ctx) => {
        return await ctx.hub.adminDb.queryHost({
          ...adminDbRequestOptions(opts),
          host_id: opts.hostId,
          sql: await readAdminDbSqlInput(opts),
          reason: opts.reason,
        });
      });
    },
  );

  adminDbCommonOptions(
    adminDb
      .command("exec")
      .description(
        "run audited operator SQL write mode; rolls back unless --commit is set",
      )
      .option("--sql <sql>", "SQL statement text")
      .option("--file <path>", "read SQL from a file")
      .requiredOption("--reason <reason>", "human-readable reason for audit")
      .requiredOption("--write", "acknowledge write-mode execution")
      .option("--commit", "commit instead of rolling back", false),
  ).action(
    async (
      opts: {
        sql?: string;
        file?: string;
        reason?: string;
        write?: boolean;
        commit?: boolean;
        bay?: string;
        limit?: string;
        timeoutMs?: string;
        lockTimeoutMs?: string;
        maxBytes?: string;
      },
      command: Command,
    ) => {
      await withContext(command, "admin db exec", async (ctx) => {
        return await ctx.hub.adminDb.exec({
          ...adminDbRequestOptions(opts),
          sql: await readAdminDbSqlInput(opts),
          reason: opts.reason,
          write: opts.write === true,
          commit: opts.commit === true,
        });
      });
    },
  );

  adminDbCommonOptions(
    adminDb.command("activity").description("show active database sessions"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db activity", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "activity",
        opts,
      });
    });
  });

  adminDbCommonOptions(
    adminDb.command("locks").description("show blocked database lock waiters"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db locks", async (ctx) => {
      return await runAdminDbDiagnostic({ ctx, diagnostic: "locks", opts });
    });
  });

  adminDbCommonOptions(
    adminDb.command("table-sizes").description("show largest database tables"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db table-sizes", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "table-sizes",
        opts,
      });
    });
  });

  adminDbCommonOptions(
    adminDb
      .command("lro")
      .description("show long-running operation rows")
      .option("--op-id <uuid>", "specific operation id")
      .option("--kind <kind>", "operation kind")
      .option("--status <status>", "operation status")
      .option("--scope-type <type>", "scope type")
      .option("--scope-id <uuid>", "scope id")
      .option("--window-minutes <n>", "updated lookback window", "1440"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db lro", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "lro",
        opts,
        params: {
          op_id: opts.opId,
          kind: opts.kind,
          status: opts.status,
          scope_type: opts.scopeType,
          scope_id: opts.scopeId,
          window_seconds:
            parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 1440,
              max: 30 * 24 * 60,
            }) * 60,
        },
      });
    });
  });

  adminDbCommonOptions(
    adminDb
      .command("backup-health")
      .description("show project backup recency and backup index state")
      .option("--project-id <uuid>", "specific project id"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db backup-health", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "backup-health",
        opts,
        params: { project_id: opts.projectId },
      });
    });
  });

  adminDbCommonOptions(
    adminDb
      .command("host-health")
      .description("show project-host heartbeat and capacity state")
      .option("--host-id <uuid>", "specific host id"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db host-health", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "host-health",
        opts,
        params: { host_id: opts.hostId },
      });
    });
  });

  adminDbCommonOptions(
    adminDb
      .command("project")
      .description("show one project control-plane row")
      .requiredOption("--project-id <uuid>", "project id"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db project", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "project",
        opts,
        params: { project_id: opts.projectId },
      });
    });
  });

  adminDbCommonOptions(
    adminDb
      .command("migration-health")
      .description("show legacy migration aggregate health"),
  ).action(async (opts: any, command: Command) => {
    await withContext(command, "admin db migration-health", async (ctx) => {
      return await runAdminDbDiagnostic({
        ctx,
        diagnostic: "migration-health",
        opts,
      });
    });
  });

  adminData
    .command("datasets")
    .description("list Admin Data Explorer datasets (admin fresh-auth)")
    .action(async (command: Command) => {
      await withContext(command, "admin data datasets", async (ctx) => {
        return await ctx.hub.adminData.listDatasets({});
      });
    });

  adminDataViews
    .command("list")
    .description("list shared Admin Data Explorer views (admin fresh-auth)")
    .option("--tag <tag>", "filter by tag")
    .option("--kind <kind>", "filter by query kind: structured, sql, dataset")
    .action(
      async (
        opts: {
          tag?: string;
          kind?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data views list", async (ctx) => {
          return await ctx.hub.adminData.listViews({
            tag: opts.tag,
            query_kind: parseAdminDataQueryKind(opts.kind),
          });
        });
      },
    );

  adminDataViews
    .command("show <slug>")
    .description("show one shared Admin Data Explorer view (admin fresh-auth)")
    .action(async (slug: string, command: Command) => {
      await withContext(command, "admin data views show", async (ctx) => {
        return await ctx.hub.adminData.getView({ slug });
      });
    });

  adminDataViews
    .command("run <slug>")
    .description(
      "run one shared Admin Data Explorer SQL view (admin fresh-auth)",
    )
    .option(
      "--limit <n>",
      "server-enforced max rows",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT}`,
    )
    .option(
      "--timeout-ms <n>",
      "server-side statement timeout",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS}`,
    )
    .option(
      "--max-bytes <n>",
      "max serialized response bytes",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES}`,
    )
    .action(
      async (
        slug: string,
        opts: {
          limit?: string;
          timeoutMs?: string;
          maxBytes?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data views run", async (ctx) => {
          return await ctx.hub.adminData.runView({
            slug,
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
            }),
            timeout_ms: parsePositiveIntegerOption({
              name: "--timeout-ms",
              value: opts.timeoutMs,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS,
            }),
            max_bytes: parsePositiveIntegerOption({
              name: "--max-bytes",
              value: opts.maxBytes,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_BYTES,
            }),
          });
        });
      },
    );

  adminDataViews
    .command("save <file>")
    .description(
      "create or update one shared Admin Data Explorer view from a JSON file (admin fresh-auth)",
    )
    .action(async (file: string, command: Command) => {
      await withContext(command, "admin data views save", async (ctx) => {
        const view = (await readAdminDataJson(file)) as AdminDataViewInput;
        return await ctx.hub.adminData.saveView({ view });
      });
    });

  adminDataViews
    .command("delete <slug>")
    .description(
      "delete one shared Admin Data Explorer view (admin fresh-auth)",
    )
    .action(async (slug: string, command: Command) => {
      await withContext(command, "admin data views delete", async (ctx) => {
        return await ctx.hub.adminData.deleteView({ slug });
      });
    });

  adminDataViews
    .command("export [file]")
    .description(
      "export shared Admin Data Explorer views as JSON (admin fresh-auth)",
    )
    .action(async (file: string | undefined, command: Command) => {
      await withContext(command, "admin data views export", async (ctx) => {
        const exported = await ctx.hub.adminData.exportViews({});
        if (file) {
          await writeFile(file, `${JSON.stringify(exported, null, 2)}\n`, {
            mode: 0o600,
          });
          return {
            path: file,
            count: exported.views.length,
            exported_at: exported.exported_at,
          };
        }
        return exported;
      });
    });

  adminDataViews
    .command("import <file>")
    .description(
      "import shared Admin Data Explorer views from JSON (admin fresh-auth)",
    )
    .option("--mode <mode>", "import mode: upsert or create-only", "upsert")
    .action(
      async (
        file: string,
        opts: {
          mode?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data views import", async (ctx) => {
          const views = (await readAdminDataJson(file)) as
            | AdminDataViewInput[]
            | AdminDataViewExport;
          return await ctx.hub.adminData.importViews({
            views,
            mode: parseAdminDataImportMode(opts.mode),
          });
        });
      },
    );

  adminDataViews
    .command("install-starters")
    .description(
      "install or update bundled starter Admin Data Explorer views (admin fresh-auth)",
    )
    .option("--mode <mode>", "import mode: upsert or create-only", "upsert")
    .action(
      async (
        opts: {
          mode?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin data views install-starters",
          async (ctx) => {
            return await ctx.hub.adminData.importViews({
              views: [...ADMIN_DATA_EXPLORER_STARTER_VIEWS],
              mode: parseAdminDataImportMode(opts.mode),
            });
          },
        );
      },
    );

  adminDataSql
    .command("validate")
    .description("validate restricted read-only SQL (admin fresh-auth)")
    .option("--query <sql>", "SQL query text")
    .option("--file <path>", "read SQL from a file")
    .option(
      "--limit <n>",
      "server-enforced max rows",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT}`,
    )
    .action(
      async (
        opts: {
          query?: string;
          file?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data sql validate", async (ctx) => {
          return await ctx.hub.adminData.validateSql({
            sql: await readAdminDataSqlInput(opts),
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
            }),
          });
        });
      },
    );

  adminDataAudit
    .command("list")
    .description("list recent Admin Data Explorer audit events")
    .option("--limit <n>", "max audit events", "50")
    .action(
      async (
        opts: {
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data audit list", async (ctx) => {
          return await ctx.hub.adminData.listAuditEvents({
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 50,
              max: 200,
            }),
          });
        });
      },
    );

  adminDataSql
    .command("run")
    .description("run restricted read-only SQL (admin fresh-auth)")
    .option("--query <sql>", "SQL query text")
    .option("--file <path>", "read SQL from a file")
    .option(
      "--limit <n>",
      "server-enforced max rows",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT}`,
    )
    .option(
      "--timeout-ms <n>",
      "server-side statement timeout",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS}`,
    )
    .option(
      "--max-bytes <n>",
      "max serialized response bytes",
      `${ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES}`,
    )
    .action(
      async (
        opts: {
          query?: string;
          file?: string;
          limit?: string;
          timeoutMs?: string;
          maxBytes?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin data sql run", async (ctx) => {
          return await ctx.hub.adminData.runSql({
            sql: await readAdminDataSqlInput(opts),
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_LIMIT,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_LIMIT,
            }),
            timeout_ms: parsePositiveIntegerOption({
              name: "--timeout-ms",
              value: opts.timeoutMs,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_TIMEOUT_MS,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_TIMEOUT_MS,
            }),
            max_bytes: parsePositiveIntegerOption({
              name: "--max-bytes",
              value: opts.maxBytes,
              fallback: ADMIN_DATA_EXPLORER_SQL_DEFAULT_MAX_BYTES,
              max: ADMIN_DATA_EXPLORER_SQL_MAX_BYTES,
            }),
          });
        });
      },
    );

  admin
    .command("health")
    .description("show minimum launch operator health checks (admin-only)")
    .option(
      "--alert-window-hours <n>",
      "admin alert lookback window in hours",
      "24",
    )
    .option(
      "--window-minutes <n>",
      "UX latency lookback window in minutes",
      "60",
    )
    .option("--wide", "show full normalized health payload")
    .action(
      async (
        opts: {
          alertWindowHours?: string;
          windowMinutes?: string;
          wide?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "admin health", async (ctx) => {
          const status = await ctx.hub.system.getLaunchHealth({
            alert_window_hours: parsePositiveIntegerOption({
              name: "--alert-window-hours",
              value: opts.alertWindowHours,
              fallback: 24,
              max: 30 * 24,
            }),
            window_minutes: parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 60,
              max: 7 * 24 * 60,
            }),
          });
          const wide =
            opts.wide ||
            ctx.globals?.json ||
            ctx.globals?.output === "json" ||
            ctx.globals?.output === "yaml";
          if (wide) {
            return status;
          }
          return formatLaunchHealthCompact(status);
        });
      },
    );

  admin
    .command("smoke")
    .description(
      "run and record a minimal launch smoke probe against an existing project (admin-only)",
    )
    .requiredOption("--project <project_id>", "project id to smoke test")
    .action(
      async (
        opts: {
          project: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin smoke", async (ctx) => {
          const projectId = `${opts.project ?? ""}`.trim();
          if (!isValidUUID(projectId)) {
            throw new Error("--project must be a project UUID");
          }
          const startedAt = new Date();
          const startedMs = Date.now();
          const steps: LaunchSmokeStepResult[] = [];
          let status: LaunchSmokeResult["status"] = "succeeded";
          let error: string | null = null;

          try {
            await runLaunchSmokeStep(steps, {
              id: "project-start",
              label: "Project start",
              run: async () => {
                const op = await ctx.hub.projects.start({
                  project_id: projectId,
                  wait: false,
                });
                const summary = await waitForLro(ctx, op.op_id, {
                  timeoutMs: ctx.timeoutMs,
                  pollMs: ctx.pollMs,
                });
                const ok =
                  summary.status === "succeeded" ||
                  (summary.status === "running" && summary.error == null);
                if (!ok) {
                  throw new Error(
                    `project start failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
                  );
                }
                return {
                  summary: `project start reached ${summary.status}`,
                  details: {
                    op_id: op.op_id,
                    status: summary.status,
                  },
                };
              },
            });

            await runLaunchSmokeStep(steps, {
              id: "project-exec",
              label: "Project exec",
              run: async () => {
                const marker = `launch-smoke-${Date.now()}`;
                const output = await ctx.hub.projects.exec({
                  project_id: projectId,
                  execOpts: {
                    command: `mkdir -p .cocalc && printf '%s\\n' '${marker}' > .cocalc/launch-smoke.txt && grep '${marker}' .cocalc/launch-smoke.txt`,
                    bash: true,
                    timeout: 30,
                    err_on_exit: false,
                  },
                });
                if (output.exit_code !== 0) {
                  throw new Error(
                    `project exec failed: exit_code=${output.exit_code} stderr=${output.stderr ?? ""}`,
                  );
                }
                return {
                  summary: "project exec wrote and read a marker file",
                  details: {
                    exit_code: output.exit_code,
                    stdout: output.stdout,
                    stderr: output.stderr,
                  },
                };
              },
            });
          } catch (err) {
            status = "failed";
            error = `${err}`;
          }

          const finishedAt = new Date();
          const result: LaunchSmokeResult = {
            project_id: projectId,
            status,
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            duration_ms: Date.now() - startedMs,
            steps,
            error,
          };
          const recorded = await ctx.hub.system.recordLaunchSmokeResult({
            result,
          });
          if (recorded.status !== "succeeded") {
            process.exitCode = 1;
          }
          return recorded;
        });
      },
    );

  admin
    .command("membership-tiers")
    .description(
      "list membership tiers with pricing and usage counts (admin-only)",
    )
    .option(
      "--prometheus",
      "emit Prometheus text exposition for command-based scraping",
    )
    .option("--wide", "show all tier inspection columns in table output")
    .action(
      async (
        opts: { prometheus?: boolean; wide?: boolean },
        command: Command,
      ) => {
        await withContext(command, "admin membership-tiers", async (ctx) => {
          const result = (await ctx.hub.db.userQuery({
            query: {
              membership_tiers: MEMBERSHIP_TIER_FIELDS,
            },
            options: [],
          })) as { membership_tiers?: MembershipTierRow[] };
          const rows = sortMembershipTierRows(result.membership_tiers ?? []);
          if (opts.prometheus) {
            return formatMembershipTiersPrometheus(rows);
          }
          const wide =
            opts.wide ||
            ctx.globals?.json ||
            ctx.globals?.output === "json" ||
            ctx.globals?.output === "yaml";
          return wide
            ? rows.map(formatMembershipTierRow)
            : rows.map(formatMembershipTierCompactRow);
        });
      },
    );

  adminMasterKey
    .command("status")
    .description(
      "show local site master key status without printing the secret key",
    )
    .action(async () => {
      console.log(JSON.stringify(await getSiteMasterKeyStatus(), null, 2));
    });

  adminMasterKey
    .command("init")
    .description("create the local site master key if it does not exist")
    .action(async () => {
      await getOrCreateSiteMasterKey();
      console.log(JSON.stringify(await getSiteMasterKeyStatus(), null, 2));
    });

  adminMasterKey
    .command("export <path>")
    .description(
      "write a backup of the one site master key; encrypted unless --plaintext is set",
    )
    .option(
      "--passphrase-env <name>",
      "read backup encryption passphrase from this environment variable",
    )
    .option(
      "--passphrase-file <path>",
      "read backup encryption passphrase from this file",
    )
    .option("--plaintext", "write an unencrypted backup file")
    .action(
      async (
        path: string,
        opts: {
          passphraseEnv?: string;
          passphraseFile?: string;
          plaintext?: boolean;
        },
      ) => {
        const backup = await createSiteMasterKeyBackup({
          passphrase: opts.plaintext
            ? undefined
            : await requirePassphraseOption(opts),
          plaintext: !!opts.plaintext,
        });
        await writeFile(path, `${JSON.stringify(backup, null, 2)}\n`, {
          mode: 0o600,
        });
        console.log(
          JSON.stringify(
            {
              path,
              encrypted: backup.encrypted,
              created_at: backup.created_at,
              site_master_key_sha256: backup.encrypted
                ? null
                : backup.key.sha256,
            },
            null,
            2,
          ),
        );
      },
    );

  adminMasterKey
    .command("import <path>")
    .description(
      "restore the site master key from a backup; refuses to overwrite by default",
    )
    .option(
      "--passphrase-env <name>",
      "read backup decryption passphrase from this environment variable",
    )
    .option(
      "--passphrase-file <path>",
      "read backup decryption passphrase from this file",
    )
    .option("--force", "overwrite a different existing local site master key")
    .action(
      async (
        path: string,
        opts: {
          passphraseEnv?: string;
          passphraseFile?: string;
          force?: boolean;
        },
      ) => {
        const backup = await readSiteMasterKeyBackupFile({
          path,
          passphrase: await resolvePassphraseOption(opts),
        });
        console.log(
          JSON.stringify(
            await restoreSiteMasterKeyBackup({
              backup,
              force: !!opts.force,
            }),
            null,
            2,
          ),
        );
      },
    );

  adminMasterKey
    .command("doctor")
    .description(
      "check local site master key state and encrypted-data migration readiness",
    )
    .option("--files-only", "skip the database scan")
    .action(async (opts: { filesOnly?: boolean }) => {
      const { getMasterKeyDoctorReport } = await loadMasterKeyMigration();
      console.log(
        JSON.stringify(
          await getMasterKeyDoctorReport({ scanDatabase: !opts.filesOnly }),
          null,
          2,
        ),
      );
    });

  adminMasterKey
    .command("migrate")
    .description(
      "offline migration from legacy master keys to the single site master key; dry-run by default",
    )
    .option("--execute", "apply database updates; otherwise only report")
    .option(
      "--yes-i-stopped-cocalc",
      "required with --execute; confirms all CoCalc services are stopped",
    )
    .action(
      async (opts: { execute?: boolean; yesIStoppedCocalc?: boolean }) => {
        if (opts.execute && !opts.yesIStoppedCocalc) {
          throw new Error(
            "--execute requires --yes-i-stopped-cocalc; this migration must be run offline",
          );
        }
        const { runMasterKeyMigration } = await loadMasterKeyMigration();
        console.log(
          JSON.stringify(
            await runMasterKeyMigration({ execute: !!opts.execute }),
            null,
            2,
          ),
        );
      },
    );

  admin
    .command("backup-shards")
    .description(
      "show project backup shard state and load (admin-only; seed-backed in multi-bay mode)",
    )
    .option("--region <region>", "restrict to a single backup region")
    .action(
      async (
        opts: {
          region?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "admin backup-shards", async (ctx) => {
          return await ctx.hub.system.getProjectBackupShards({
            region: opts.region?.trim() || undefined,
          });
        });
      },
    );

  admin
    .command("acp-denials")
    .description(
      "show repeated ACP admission-denied events from central_log (admin-only)",
    )
    .option("--window-minutes <n>", "lookback window in minutes", "60")
    .option("--min-count <n>", "minimum grouped denial count", "1")
    .option("--limit <n>", "maximum grouped rows", "50")
    .option("--account <account>", "filter by account id, email, or name query")
    .option("--project <project_id>", "filter by project id")
    .option(
      "--denial-limit <name>",
      "filter by denial limit, e.g. queued_per_account",
    )
    .option("--source <source>", "filter by source: chat, automation, claim")
    .option(
      "--prometheus",
      "emit Prometheus text exposition for command-based scraping",
    )
    .action(
      async (
        opts: {
          windowMinutes?: string;
          minCount?: string;
          limit?: string;
          account?: string;
          project?: string;
          denialLimit?: string;
          source?: string;
          prometheus?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "admin acp-denials", async (ctx) => {
          const userAccountId = opts.account
            ? await resolveTargetAccountId(ctx, opts.account)
            : undefined;
          const report = await ctx.hub.system.getAcpAdmissionDenialReport({
            window_minutes: parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 60,
              max: 7 * 24 * 60,
            }),
            min_count: parsePositiveIntegerOption({
              name: "--min-count",
              value: opts.minCount,
              fallback: 1,
              max: 1_000_000,
            }),
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 50,
              max: 500,
            }),
            user_account_id: userAccountId,
            project_id: opts.project?.trim() || undefined,
            denial_limit: opts.denialLimit?.trim() || undefined,
            source: opts.source?.trim() || undefined,
          });
          if (opts.prometheus) {
            return formatAcpDenialPrometheus(report);
          }
          return report.groups ?? [];
        });
      },
    );

  admin
    .command("service-denials")
    .description(
      "show repeated service admission-denied events from central_log (admin-only)",
    )
    .option("--window-minutes <n>", "lookback window in minutes", "60")
    .option("--min-count <n>", "minimum grouped denial count", "1")
    .option("--limit <n>", "maximum grouped rows", "50")
    .option("--account <account>", "filter by account id, email, or name query")
    .option("--project <project_id>", "filter by project id")
    .option("--surface <surface>", "filter by service surface")
    .option("--denial-limit <name>", "filter by denial limit/env var")
    .option("--source <source>", "filter by source")
    .option(
      "--prometheus",
      "emit Prometheus text exposition for command-based scraping",
    )
    .action(
      async (
        opts: {
          windowMinutes?: string;
          minCount?: string;
          limit?: string;
          account?: string;
          project?: string;
          surface?: string;
          denialLimit?: string;
          source?: string;
          prometheus?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "admin service-denials", async (ctx) => {
          const userAccountId = opts.account
            ? await resolveTargetAccountId(ctx, opts.account)
            : undefined;
          const report = await ctx.hub.system.getServiceAdmissionDenialReport({
            window_minutes: parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 60,
              max: 7 * 24 * 60,
            }),
            min_count: parsePositiveIntegerOption({
              name: "--min-count",
              value: opts.minCount,
              fallback: 1,
              max: 1_000_000,
            }),
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 50,
              max: 500,
            }),
            user_account_id: userAccountId,
            project_id: opts.project?.trim() || undefined,
            surface: opts.surface?.trim() || undefined,
            denial_limit: opts.denialLimit?.trim() || undefined,
            source: opts.source?.trim() || undefined,
          });
          if (opts.prometheus) {
            return formatServiceDenialPrometheus(report);
          }
          return report.groups ?? [];
        });
      },
    );

  admin
    .command("rootfs-quotas")
    .description(
      "show RootFS top users, near-limit accounts, and recent quota denials (admin-only)",
    )
    .option("--limit <n>", "maximum rows in each report section", "50")
    .option("--near-percent <n>", "near-limit threshold percentage", "80")
    .option("--window-minutes <n>", "denial lookback window in minutes", "60")
    .option("--min-count <n>", "minimum grouped denial count", "1")
    .option("--account <account>", "filter by account id, email, or name query")
    .option("--denial-limit <name>", "filter by denial limit")
    .option("--operation <operation>", "filter by operation")
    .option(
      "--prometheus",
      "emit Prometheus text exposition for command-based scraping",
    )
    .action(
      async (
        opts: {
          limit?: string;
          nearPercent?: string;
          windowMinutes?: string;
          minCount?: string;
          account?: string;
          denialLimit?: string;
          operation?: string;
          prometheus?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "admin rootfs-quotas", async (ctx) => {
          const userAccountId = opts.account
            ? await resolveTargetAccountId(ctx, opts.account)
            : undefined;
          const report = await ctx.hub.system.getRootfsQuotaReport({
            limit: parsePositiveIntegerOption({
              name: "--limit",
              value: opts.limit,
              fallback: 50,
              max: 500,
            }),
            near_percent: parsePositiveIntegerOption({
              name: "--near-percent",
              value: opts.nearPercent,
              fallback: 80,
              max: 100,
            }),
            window_minutes: parsePositiveIntegerOption({
              name: "--window-minutes",
              value: opts.windowMinutes,
              fallback: 60,
              max: 7 * 24 * 60,
            }),
            min_count: parsePositiveIntegerOption({
              name: "--min-count",
              value: opts.minCount,
              fallback: 1,
              max: 1_000_000,
            }),
            user_account_id: userAccountId,
            denial_limit: opts.denialLimit?.trim() || undefined,
            operation: opts.operation?.trim() || undefined,
          });
          if (opts.prometheus) {
            return formatRootfsQuotaPrometheus(report);
          }
          return report;
        });
      },
    );

  adminUser
    .command("create")
    .description("create an account (admin only)")
    .requiredOption("--email <email>", "email address")
    .option(
      "--password <password>",
      "password (omit to auto-generate a random 24-character password)",
    )
    .option("--first-name <firstName>", "first name")
    .option("--last-name <lastName>", "last name")
    .option("--name <name>", "display name")
    .option("--tag <tag...>", "optional account tags")
    .action(
      async (
        opts: {
          email: string;
          password?: string;
          firstName?: string;
          lastName?: string;
          name?: string;
          tag?: string[];
        },
        command: Command,
      ) => {
        await withContext(command, "admin user create", async (ctx) => {
          const email = `${opts.email ?? ""}`.trim();
          if (!email) {
            throw new Error("--email is required");
          }

          let firstName = opts.firstName?.trim();
          let lastName = opts.lastName?.trim();
          const displayName = opts.name?.trim();
          if (displayName) {
            const parts = displayName.split(/\s+/).filter(Boolean);
            if (!firstName && parts.length) {
              firstName = parts[0];
            }
            if (!lastName && parts.length > 1) {
              lastName = parts.slice(1).join(" ");
            }
          }

          const created = await ctx.hub.system.adminCreateUser({
            email,
            password: opts.password,
            display_name: displayName,
            first_name: firstName,
            last_name: lastName,
            tags: opts.tag && opts.tag.length ? opts.tag : undefined,
          });

          return created;
        });
      },
    );

  adminUser
    .command("ban <user>")
    .description(
      "ban an account and equivalent email identities (account id, email, or name query)",
    )
    .requiredOption("--reason <reason>", "audit reason for the account ban")
    .action(
      async (user: string, opts: { reason: string }, command: Command) => {
        await withContext(command, "admin user ban", async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          return await ctx.hub.system.adminBanUser({
            user_account_id: userAccountId,
            reason: opts.reason,
          });
        });
      },
    );

  adminUser
    .command("unban <user>")
    .description(
      "remove one account ban; quarantined billing/resources require separate review",
    )
    .requiredOption("--reason <reason>", "audit reason for removing the ban")
    .action(
      async (user: string, opts: { reason: string }, command: Command) => {
        await withContext(command, "admin user unban", async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          return await ctx.hub.system.adminUnbanUser({
            user_account_id: userAccountId,
            reason: opts.reason,
          });
        });
      },
    );

  adminUser
    .command("issue-impersonation-link <user>")
    .description(
      "create an impersonation sign-in link for a user (account id, email, or name query)",
    )
    .action(async (user: string, _opts: {}, command: Command) => {
      await withContext(
        command,
        "admin user issue-impersonation-link",
        async (ctx) => {
          const identifier = `${user ?? ""}`.trim();
          if (!identifier) {
            throw new Error("user identifier must be non-empty");
          }

          const resolved = isValidUUID(identifier)
            ? { account_id: identifier }
            : await resolveAccountByIdentifier(ctx, identifier);
          const userAccountId = `${resolved?.account_id ?? ""}`.trim();
          if (!userAccountId) {
            throw new Error(`unable to resolve account for '${identifier}'`);
          }

          const grant = await ctx.hub.system.createImpersonationGrant({
            subject_account_id: userAccountId,
          });

          return {
            user_account_id: userAccountId,
            grant_id: grant.grant_id,
            subject_home_bay_id: grant.subject_home_bay_id,
            url: grant.url,
            expires_at: grant.expires_at,
          };
        },
      );
    });

  adminEntitlementOverride
    .command("schema")
    .description("print the accepted entitlement override JSON schema")
    .action(() => {
      console.log(JSON.stringify(buildEntitlementOverrideSchemaDoc(), null, 2));
    });

  adminEntitlementOverride
    .command("get <user>")
    .description("get the active admin entitlement override for a user")
    .action(async (user: string, command: Command) => {
      await withContext(
        command,
        "admin entitlement-override get",
        async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          const override = await ctx.hub.system.getAccountEntitlementOverride({
            user_account_id: userAccountId,
          });
          return {
            account_id: userAccountId,
            override: override ?? null,
          };
        },
      );
    });

  adminEntitlementOverride
    .command("set <user>")
    .description("set or replace the admin entitlement override for a user")
    .requiredOption("--file <path>", "JSON file containing the override object")
    .requiredOption("--reason <reason>", "required audit reason")
    .option(
      "--expires-at <iso>",
      "override expiration as ISO-8601, or none/null/never",
    )
    .addHelpText(
      "after",
      `
Run "cocalc admin entitlement-override schema" for the accepted JSON payload.
`,
    )
    .action(
      async (
        user: string,
        opts: { file: string; reason: string; expiresAt?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin entitlement-override set",
          async (ctx) => {
            const userAccountId = await resolveTargetAccountId(ctx, user);
            const override = await readOverrideFile(opts.file);
            const expiresAt = parseExpiresAtOption(opts.expiresAt);
            if (expiresAt !== undefined) {
              override.expires_at = expiresAt;
            }
            const saved = await ctx.hub.system.setAccountEntitlementOverride({
              user_account_id: userAccountId,
              override,
              reason: requireReason(opts.reason),
            });
            return {
              account_id: userAccountId,
              override: saved,
            };
          },
        );
      },
    );

  adminEntitlementOverride
    .command("clear <user>")
    .description("clear the admin entitlement override for a user")
    .requiredOption("--reason <reason>", "required audit reason")
    .action(
      async (user: string, opts: { reason: string }, command: Command) => {
        await withContext(
          command,
          "admin entitlement-override clear",
          async (ctx) => {
            const userAccountId = await resolveTargetAccountId(ctx, user);
            await ctx.hub.system.clearAccountEntitlementOverride({
              user_account_id: userAccountId,
              reason: requireReason(opts.reason),
            });
            return {
              account_id: userAccountId,
              cleared: true,
            };
          },
        );
      },
    );

  adminMembershipAssignment
    .command("get <user>")
    .description("get the admin-assigned membership for a user")
    .action(async (user: string, command: Command) => {
      await withContext(
        command,
        "admin membership-assignment get",
        async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          const assignment = await ctx.hub.system.getAdminAssignedMembership({
            user_account_id: userAccountId,
          });
          return {
            account_id: userAccountId,
            assignment: assignment ?? null,
          };
        },
      );
    });

  adminMembershipAssignment
    .command("set <user>")
    .description("set or replace the admin-assigned membership for a user")
    .requiredOption("--tier <id>", "membership tier id, e.g. member")
    .requiredOption(
      "--expires-at <iso>",
      "expiration as ISO-8601, or never for a permanent assignment",
    )
    .requiredOption("--reason <reason>", "reason stored with the assignment")
    .action(
      async (
        user: string,
        opts: { tier: string; expiresAt: string; reason: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin membership-assignment set",
          async (ctx) => {
            const userAccountId = await resolveTargetAccountId(ctx, user);
            const membershipClass = await requireAssignableMembershipTier(
              ctx,
              opts.tier,
            );
            const expiresAt = parseMembershipAssignmentExpiration(
              opts.expiresAt,
            );
            await ctx.hub.system.setAdminAssignedMembership({
              user_account_id: userAccountId,
              membership_class: membershipClass,
              expires_at: expiresAt,
              notes: requireReason(opts.reason),
            });
            const assignment = await ctx.hub.system.getAdminAssignedMembership({
              user_account_id: userAccountId,
            });
            return {
              account_id: userAccountId,
              assignment: assignment ?? null,
            };
          },
        );
      },
    );

  adminMembershipAssignment
    .command("clear <user>")
    .description("clear the admin-assigned membership for a user")
    .action(async (user: string, command: Command) => {
      await withContext(
        command,
        "admin membership-assignment clear",
        async (ctx) => {
          const userAccountId = await resolveTargetAccountId(ctx, user);
          await ctx.hub.system.clearAdminAssignedMembership({
            user_account_id: userAccountId,
          });
          return {
            account_id: userAccountId,
            cleared: true,
          };
        },
      );
    });

  adminMessage
    .command("send-system-notice")
    .description(
      "send a system-generated notice through the legacy messages pipeline",
    )
    .requiredOption(
      "--target <account_or_email>",
      "target account id or email address (repeat for multiple targets)",
      pushString,
      [],
    )
    .requiredOption("--subject <subject>", "short plain text subject")
    .option(
      "--body-markdown <markdown>",
      "markdown body inline on the command line",
    )
    .option("--body-file <path>", "read markdown body from a file")
    .option(
      "--dedup-minutes <minutes>",
      "optional dedupe window for repeated identical system notices",
    )
    .action(
      async (
        opts: {
          target: string[];
          subject: string;
          bodyMarkdown?: string;
          bodyFile?: string;
          dedupMinutes?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "admin message send-system-notice",
          async (ctx) => {
            const dedupMinutesRaw = `${opts.dedupMinutes ?? ""}`.trim();
            const parsedDedupMinutes =
              dedupMinutesRaw === ""
                ? undefined
                : Number.parseInt(dedupMinutesRaw, 10);
            if (
              dedupMinutesRaw !== "" &&
              (parsedDedupMinutes == null ||
                !Number.isInteger(parsedDedupMinutes) ||
                parsedDedupMinutes <= 0)
            ) {
              throw new Error("--dedup-minutes must be a positive integer");
            }
            const dedupMinutes = parsedDedupMinutes;
            return await ctx.hub.messages.sendSystemNotice({
              to_ids: opts.target.map((target) => target.trim()),
              subject: `${opts.subject ?? ""}`,
              body: await resolveBodyMarkdown(opts),
              dedupMinutes,
            });
          },
        );
      },
    );

  return admin;
}
