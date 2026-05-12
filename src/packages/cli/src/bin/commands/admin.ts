import { Command } from "commander";
import { ADMIN_SEARCH_LIMIT } from "@cocalc/util/db-schema/accounts";
import { MEMBERSHIP_ENTITLEMENT_OVERRIDE_DESCRIPTIONS } from "@cocalc/util/membership-entitlement-overrides";
import { readFile } from "node:fs/promises";
import type { AccountEntitlementOverride } from "@cocalc/conat/hub/api/purchases";

export type AdminCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  isValidUUID: any;
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
      {
        path: "dedicated_hosts.funding_mode",
        kind: "enum_rule",
        label: "Dedicated-host funding mode",
        values: ["account-prepaid", "account-postpaid", "site-funded"],
        description:
          "Advanced/internal account-specific default/policy for dedicated-host funding mode.",
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

function formatAcpDenialPrometheus(report: any): string {
  const lines = [
    "# HELP cocalc_acp_admission_denials_window_total ACP admission denials in the selected recent time window.",
    "# TYPE cocalc_acp_admission_denials_window_total gauge",
  ];
  const windowMinutes = report?.window_minutes ?? "";
  for (const group of report?.groups ?? []) {
    const labels = prometheusLabels({
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

export function registerAdminCommand(
  program: Command,
  deps: AdminCommandDeps,
): Command {
  const { withContext, resolveAccountByIdentifier, isValidUUID } = deps;

  const admin = program.command("admin").description("site admin operations");
  const adminUser = admin.command("user").description("admin user management");
  const adminMessage = admin
    .command("message")
    .description("admin system message operations");
  const adminEntitlementOverride = admin
    .command("entitlement-override")
    .description("admin account entitlement override operations")
    .addHelpText("after", ENTITLEMENT_OVERRIDE_HELP);

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
            first_name?: string;
            last_name?: string;
            name?: string;
            email_address?: string;
            last_active?: number;
            created?: number;
            banned?: boolean;
            email_address_verified?: boolean;
          }>;

          return (rows ?? []).map((row) => ({
            account_id: row.account_id,
            name:
              `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() ||
              row.name ||
              "",
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
          }));
        });
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
    .option("--name <name>", "full name shorthand (split into first/last)")
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
          if (opts.name?.trim()) {
            const parts = opts.name.trim().split(/\s+/).filter(Boolean);
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
            first_name: firstName,
            last_name: lastName,
            tags: opts.tag && opts.tag.length ? opts.tag : undefined,
          });

          return created;
        });
      },
    );

  adminUser
    .command("issue-auth-token <user>")
    .description(
      "create an impersonation sign-in link for a user (account id, email, or name query)",
    )
    .action(async (user: string, _opts: {}, command: Command) => {
      await withContext(command, "admin user issue-auth-token", async (ctx) => {
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
      });
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
