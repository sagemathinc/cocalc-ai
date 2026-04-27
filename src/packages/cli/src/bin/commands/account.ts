import { Command } from "commander";

import type {
  ManagedEgressEventSummary,
  MembershipDetails,
} from "@cocalc/conat/hub/api/purchases";

export type AccountCommandDeps = {
  withContext: any;
  toIso: any;
  resolveAccountByIdentifier: any;
};

function formatByteCount(bytes: unknown): string | null {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  const digits = n >= 10 || unit === 0 ? 0 : 1;
  return `${n.toFixed(digits)} ${units[unit]}`;
}

function serializeManagedEgressEvent(
  event: ManagedEgressEventSummary,
  toIso: AccountCommandDeps["toIso"],
) {
  return {
    occurred_at: toIso(event.occurred_at),
    project_id: event.project_id,
    project_title: event.project_title ?? null,
    category: event.category,
    bytes: event.bytes,
    bytes_human: formatByteCount(event.bytes),
    metadata: event.metadata ?? null,
  };
}

function serializeMembershipDetails(
  details: MembershipDetails,
  account_id: string,
  toIso: AccountCommandDeps["toIso"],
) {
  const usageLimits = details.selected.entitlements.usage_limits ?? {};
  const usage = details.usage_status;
  return {
    account_id,
    membership_class: details.selected.class,
    membership_source: details.selected.source,
    membership_expires: toIso(details.selected.expires),
    shared_compute_priority: usageLimits.shared_compute_priority ?? null,
    total_storage_soft_bytes: usageLimits.total_storage_soft_bytes ?? null,
    total_storage_soft: formatByteCount(usageLimits.total_storage_soft_bytes),
    total_storage_hard_bytes: usageLimits.total_storage_hard_bytes ?? null,
    total_storage_hard: formatByteCount(usageLimits.total_storage_hard_bytes),
    max_owned_projects: usageLimits.max_projects ?? null,
    managed_egress_5h_limit_bytes: usageLimits.egress_5h_bytes ?? null,
    managed_egress_5h_limit: formatByteCount(usageLimits.egress_5h_bytes),
    managed_egress_7d_limit_bytes: usageLimits.egress_7d_bytes ?? null,
    managed_egress_7d_limit: formatByteCount(usageLimits.egress_7d_bytes),
    managed_egress_policy: usageLimits.egress_policy ?? null,
    dedicated_host_egress_policy:
      usageLimits.dedicated_host_egress_policy ?? null,
    collected_at: toIso(usage?.collected_at),
    owned_project_count: usage?.owned_project_count ?? null,
    sampled_project_count: usage?.sampled_project_count ?? null,
    unsampled_project_count: usage?.unsampled_project_count ?? null,
    measurement_error_count: usage?.measurement_error_count ?? 0,
    total_storage_used_bytes: usage?.total_storage_bytes ?? null,
    total_storage_used: formatByteCount(usage?.total_storage_bytes),
    total_storage_soft_remaining_bytes:
      usage?.total_storage_soft_remaining_bytes ?? null,
    total_storage_soft_remaining: formatByteCount(
      usage?.total_storage_soft_remaining_bytes,
    ),
    total_storage_hard_remaining_bytes:
      usage?.total_storage_hard_remaining_bytes ?? null,
    total_storage_hard_remaining: formatByteCount(
      usage?.total_storage_hard_remaining_bytes,
    ),
    over_total_storage_soft: usage?.over_total_storage_soft ?? false,
    over_total_storage_hard: usage?.over_total_storage_hard ?? false,
    remaining_project_slots: usage?.remaining_project_slots ?? null,
    over_max_projects: usage?.over_max_projects ?? false,
    managed_egress_5h_used_bytes: usage?.managed_egress_5h_bytes ?? null,
    managed_egress_5h_used: formatByteCount(usage?.managed_egress_5h_bytes),
    managed_egress_7d_used_bytes: usage?.managed_egress_7d_bytes ?? null,
    managed_egress_7d_used: formatByteCount(usage?.managed_egress_7d_bytes),
    managed_egress_5h_remaining_bytes:
      usage?.managed_egress_5h_remaining_bytes ?? null,
    managed_egress_5h_remaining: formatByteCount(
      usage?.managed_egress_5h_remaining_bytes,
    ),
    managed_egress_7d_remaining_bytes:
      usage?.managed_egress_7d_remaining_bytes ?? null,
    managed_egress_7d_remaining: formatByteCount(
      usage?.managed_egress_7d_remaining_bytes,
    ),
    over_managed_egress_5h: usage?.over_managed_egress_5h ?? false,
    over_managed_egress_7d: usage?.over_managed_egress_7d ?? false,
    managed_egress_categories_5h_bytes:
      usage?.managed_egress_categories_5h_bytes ?? {},
    managed_egress_categories_7d_bytes:
      usage?.managed_egress_categories_7d_bytes ?? {},
    managed_egress_recent_events: (
      usage?.managed_egress_recent_events ?? []
    ).map((event) => serializeManagedEgressEvent(event, toIso)),
    candidates: details.candidates.map((candidate) => ({
      class: candidate.class,
      source: candidate.source,
      priority: candidate.priority,
      subscription_id: candidate.subscription_id ?? null,
      expires: toIso(candidate.expires),
      usage_limits: candidate.entitlements.usage_limits ?? {},
    })),
  };
}

export function registerAccountCommand(
  program: Command,
  deps: AccountCommandDeps,
): Command {
  const { withContext, toIso, resolveAccountByIdentifier } = deps;

  const account = program.command("account").description("account operations");

  account
    .command("where [account]")
    .description("show the home bay for an account")
    .action(async (accountIdentifier: string | undefined, command: Command) => {
      await withContext(command, "account where", async (ctx) => {
        const target = accountIdentifier?.trim()
          ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
          : { account_id: ctx.accountId };
        return await ctx.hub.system.getAccountBay({
          user_account_id: target.account_id,
        });
      });
    });

  account
    .command("membership [account]")
    .description(
      "show membership limits and current shared-host usage for an account",
    )
    .action(async (accountIdentifier: string | undefined, command: Command) => {
      await withContext(command, "account membership", async (ctx) => {
        const target = accountIdentifier?.trim()
          ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
          : { account_id: ctx.accountId };
        const account_id = `${target.account_id ?? ""}`.trim();
        if (!account_id) {
          throw new Error("unable to resolve target account");
        }
        const details = await ctx.hub.purchases.getMembershipDetails({
          user_account_id: account_id,
        });
        return serializeMembershipDetails(details, account_id, toIso);
      });
    });

  account
    .command("delete [account]")
    .description(
      "delete an account (defaults to the signed-in account; admins can delete another account)",
    )
    .option(
      "--only-if-tag <tag>",
      "refuse deletion unless the target account has this tag",
    )
    .option("-y, --yes", "skip interactive safety confirmation")
    .action(
      async (
        accountIdentifier: string | undefined,
        opts: { onlyIfTag?: string; yes?: boolean },
        command: Command,
      ) => {
        await withContext(command, "account delete", async (ctx) => {
          const target = accountIdentifier?.trim()
            ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
            : { account_id: ctx.accountId, email_address: null, name: "" };
          const accountId = `${target.account_id ?? ""}`.trim();
          if (!accountId) {
            throw new Error("unable to resolve target account");
          }
          if (!opts.yes) {
            const label =
              `${target.email_address ?? target.name ?? ""}`.trim() ||
              accountId;
            throw new Error(
              `refusing to delete account '${label}' without --yes`,
            );
          }
          const result = await ctx.hub.system.deleteAccount({
            user_account_id: accountId,
            only_if_tag: `${opts.onlyIfTag ?? ""}`.trim() || undefined,
          });
          return {
            account_id: result.account_id,
            home_bay_id: result.home_bay_id,
            status: result.status,
            only_if_tag: `${opts.onlyIfTag ?? ""}`.trim() || null,
          };
        });
      },
    );

  account
    .command("rehome <account>")
    .description("move an account's home bay")
    .requiredOption("--bay <bay>", "destination account home bay")
    .option("--reason <reason>", "operator-visible reason")
    .option("--campaign <id>", "operator-visible batch/campaign id")
    .option("-y, --yes", "skip interactive safety confirmation")
    .action(
      async (
        accountIdentifier: string,
        opts: {
          bay?: string;
          reason?: string;
          campaign?: string;
          yes?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome", async (ctx) => {
          const target = await resolveAccountByIdentifier(
            ctx,
            accountIdentifier.trim(),
          );
          const accountId = `${target.account_id ?? ""}`.trim();
          if (!accountId) {
            throw new Error("unable to resolve target account");
          }
          const destBayId = `${opts.bay ?? ""}`.trim();
          if (!destBayId) {
            throw new Error("--bay is required");
          }
          if (!opts.yes) {
            const label =
              `${target.email_address ?? target.name ?? ""}`.trim() ||
              accountId;
            throw new Error(
              `refusing to rehome account '${label}' without --yes`,
            );
          }
          return await ctx.hub.system.rehomeAccount({
            user_account_id: accountId,
            dest_bay_id: destBayId,
            reason: `${opts.reason ?? ""}`.trim() || undefined,
            campaign_id: `${opts.campaign ?? ""}`.trim() || undefined,
          });
        });
      },
    );

  account
    .command("rehome-status")
    .description("show an account rehome operation")
    .requiredOption("--op-id <uuid>", "account rehome operation id")
    .option("--source-bay <bay>", "source bay that owns the rehome operation")
    .action(
      async (
        opts: {
          opId?: string;
          sourceBay?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome-status", async (ctx) => {
          const op = await ctx.hub.system.getAccountRehomeOperation({
            op_id: `${opts.opId ?? ""}`.trim(),
            source_bay_id: `${opts.sourceBay ?? ""}`.trim() || undefined,
          });
          if (!op) {
            throw new Error(`account rehome operation ${opts.opId} not found`);
          }
          return op;
        });
      },
    );

  account
    .command("rehome-reconcile")
    .description("retry/resume an account rehome operation")
    .requiredOption("--op-id <uuid>", "account rehome operation id")
    .option("--source-bay <bay>", "source bay that owns the rehome operation")
    .action(
      async (
        opts: {
          opId?: string;
          sourceBay?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome-reconcile", async (ctx) => {
          return await ctx.hub.system.reconcileAccountRehome({
            op_id: `${opts.opId ?? ""}`.trim(),
            source_bay_id: `${opts.sourceBay ?? ""}`.trim() || undefined,
          });
        });
      },
    );

  account
    .command("rehome-drain")
    .description("batch rehome accounts off the current/source bay")
    .requiredOption("--dest-bay <bay>", "destination account home bay")
    .option("--source-bay <bay>", "source bay id; defaults to current bay")
    .option("--limit <n>", "maximum accounts to process", "25")
    .option("--campaign <id>", "operator campaign/drain identifier")
    .option("--reason <reason>", "operator reason, e.g. maintenance or load")
    .option("--only-if-tag <tag>", "only drain accounts with this tag")
    .option("--write", "apply changes instead of dry run", false)
    .action(
      async (
        opts: {
          destBay?: string;
          sourceBay?: string;
          limit?: string;
          campaign?: string;
          reason?: string;
          onlyIfTag?: string;
          write?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "account rehome-drain", async (ctx) => {
          const limit = Number(opts.limit ?? "25");
          if (!Number.isInteger(limit) || limit <= 0) {
            throw new Error("--limit must be a positive integer");
          }
          const destBayId = `${opts.destBay ?? ""}`.trim();
          if (!destBayId) {
            throw new Error("--dest-bay is required");
          }
          return await ctx.hub.system.drainAccountRehome({
            source_bay_id: `${opts.sourceBay ?? ""}`.trim() || undefined,
            dest_bay_id: destBayId,
            limit,
            dry_run: opts.write !== true,
            campaign_id: `${opts.campaign ?? ""}`.trim() || undefined,
            reason: `${opts.reason ?? ""}`.trim() || undefined,
            only_if_tag: `${opts.onlyIfTag ?? ""}`.trim() || undefined,
          });
        });
      },
    );

  const accountApiKey = account
    .command("api-key")
    .description("manage account API keys");

  accountApiKey
    .command("list")
    .description("list account API keys")
    .action(async (command: Command) => {
      await withContext(command, "account api-key list", async (ctx) => {
        const rows = (await ctx.hub.system.manageApiKeys({
          action: "get",
        })) as Array<{
          id?: number;
          key_id?: string;
          name?: string;
          trunc?: string;
          created?: string | Date | null;
          expire?: string | Date | null;
          last_active?: string | Date | null;
          project_id?: string | null;
        }>;
        return (rows ?? []).map((row) => ({
          id: row.id,
          key_id: row.key_id ?? null,
          name: row.name ?? "",
          trunc: row.trunc ?? "",
          created: toIso(row.created),
          expire: toIso(row.expire),
          last_active: toIso(row.last_active),
          project_id: row.project_id ?? null,
        }));
      });
    });

  accountApiKey
    .command("create")
    .description("create an account API key")
    .option(
      "--name <name>",
      "key label",
      `cocalc-cli-${Date.now().toString(36)}`,
    )
    .option("--expire-seconds <n>", "expire in n seconds")
    .action(
      async (
        opts: {
          name?: string;
          expireSeconds?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "account api-key create", async (ctx) => {
          const expireSeconds =
            opts.expireSeconds == null ? undefined : Number(opts.expireSeconds);
          if (
            expireSeconds != null &&
            (!Number.isFinite(expireSeconds) || expireSeconds <= 0)
          ) {
            throw new Error("--expire-seconds must be a positive number");
          }
          const expire = expireSeconds
            ? new Date(Date.now() + expireSeconds * 1000)
            : undefined;
          const rows = (await ctx.hub.system.manageApiKeys({
            action: "create",
            name: opts.name,
            expire,
          })) as Array<{
            id?: number;
            key_id?: string;
            name?: string;
            trunc?: string;
            secret?: string;
            created?: string | Date | null;
            expire?: string | Date | null;
            project_id?: string | null;
          }>;
          const key = rows?.[0];
          if (!key?.id) {
            throw new Error("failed to create api key");
          }
          return {
            id: key.id,
            key_id: key.key_id ?? null,
            name: key.name ?? opts.name ?? "",
            trunc: key.trunc ?? "",
            secret: key.secret ?? null,
            created: toIso(key.created),
            expire: toIso(key.expire),
            project_id: key.project_id ?? null,
          };
        });
      },
    );

  accountApiKey
    .command("delete <id>")
    .description("delete an account API key by id")
    .action(async (id: string, command: Command) => {
      await withContext(command, "account api-key delete", async (ctx) => {
        const keyId = Number(id);
        if (!Number.isInteger(keyId) || keyId <= 0) {
          throw new Error("id must be a positive integer");
        }
        await ctx.hub.system.manageApiKeys({
          action: "delete",
          id: keyId,
        });
        return {
          id: keyId,
          status: "deleted",
        };
      });
    });

  return account;
}
