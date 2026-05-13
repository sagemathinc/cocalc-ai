import { Command } from "commander";
import { humanSize } from "@cocalc/util/misc";

export type CloudflareCommandDeps = {
  withContext: any;
};

function summarizePlan(plan: any) {
  const summary = plan.summary ?? {};
  return {
    plan_id: plan.id ?? summary.plan_id,
    status: plan.status ?? summary.status,
    include_r2: plan.include_r2 ?? summary.include_r2,
    expires_at: plan.expires_at ?? summary.expires_at,
    cloudflare_account_id: plan.cloudflare_account_id,
    zone: plan.zone_name
      ? `${plan.zone_name}${plan.zone_id ? ` (${plan.zone_id})` : ""}`
      : (plan.zone_id ?? ""),
    selected_tunnels: summary.selected?.tunnels ?? 0,
    selected_dns_records: summary.selected?.dns_records ?? 0,
    selected_r2_buckets: summary.selected?.r2_buckets ?? 0,
    active_projects: summary.counts?.active_projects ?? 0,
    archived_project_candidates:
      summary.counts?.archived_project_candidates ?? 0,
    projects_with_backups: summary.counts?.projects_with_backups ?? 0,
    r2_bucket_records: summary.counts?.r2_bucket_records ?? 0,
    cloudflare_r2_buckets: summary.counts?.cloudflare_r2_buckets ?? 0,
    confirmation_text: plan.confirmation_text ?? summary.confirmation_text,
    warnings: (summary.warnings ?? []).join(" "),
    notes: (summary.notes ?? []).join(" "),
  };
}

function summarizeResources(plan: any) {
  const resources = plan.plan_json?.resources ?? [];
  return resources.map((resource: any) => ({
    kind: resource.kind,
    classification: resource.classification,
    id: resource.id ?? "",
    name: resource.name ?? "",
    reason: resource.reason ?? "",
  }));
}

function bytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return humanSize(value, { binary: true });
}

function summarizeR2Usage(result: any) {
  return {
    checked_at: result.checked_at,
    account_id: result.account_id,
    bucket_prefix: result.bucket_prefix ?? "",
    filtered_by_prefix: result.filtered_by_prefix ?? false,
    bucket_count: result.bucket_count ?? 0,
    cloudflare_bucket_count: result.cloudflare_bucket_count ?? "",
    total_objects: result.totals?.object_count ?? "",
    total_size: bytes(result.totals?.total_bytes),
    total_payload: bytes(result.totals?.payload_bytes),
    total_metadata: bytes(result.totals?.metadata_bytes),
    pending_uploads: result.totals?.upload_count ?? "",
    warnings: (result.warnings ?? []).join(" "),
    notes: (result.notes ?? []).join(" "),
  };
}

function r2UsageRows(result: any) {
  if ((result.buckets ?? []).length === 0) {
    return [summarizeR2Usage(result)];
  }
  return (result.buckets ?? []).map((bucket: any) => ({
    bucket: bucket.bucket,
    objects: bucket.object_count ?? "",
    total: bytes(bucket.total_bytes),
    payload: bytes(bucket.payload_bytes),
    metadata: bytes(bucket.metadata_bytes),
    pending_uploads: bucket.upload_count ?? "",
    measured_at: bucket.measured_at ?? "",
    source: bucket.metrics_source ?? "",
    db_purpose: bucket.database?.purpose ?? "",
    db_region: bucket.database?.region ?? "",
    db_projects: bucket.database?.assigned_projects ?? "",
  }));
}

function summarizeR2Audit(result: any) {
  return {
    bucket: result.bucket,
    prefix: result.prefix ?? "",
    scanned_at: result.scanned_at,
    cache_hit: result.cache?.hit ?? false,
    cache_expires_at: result.cache?.expires_at ?? "",
    objects: result.object_count ?? 0,
    total: bytes(result.total_bytes),
    db_purpose: result.database?.purpose ?? "",
    db_region: result.database?.region ?? "",
    db_projects: result.database?.assigned_projects ?? "",
    warnings: (result.warnings ?? []).join(" "),
    notes: (result.notes ?? []).join(" "),
  };
}

function r2AuditCategoryRows(result: any) {
  return (result.categories ?? []).map((row: any) => ({
    category: row.category,
    objects: row.object_count,
    total: bytes(row.total_bytes),
    examples: (row.examples ?? []).join(" "),
  }));
}

function r2AuditPrefixRows(result: any) {
  return (result.top_prefixes ?? []).map((row: any) => ({
    prefix: row.prefix,
    objects: row.object_count,
    total: bytes(row.total_bytes),
  }));
}

function r2AuditObjectRows(result: any) {
  return (result.top_objects ?? []).map((row: any) => ({
    key: row.key,
    size: bytes(row.size),
  }));
}

function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("expected a nonnegative integer");
  }
  return n;
}

export function registerCloudflareCommand(
  program: Command,
  deps: CloudflareCommandDeps,
) {
  const cloudflare = program
    .command("cloudflare")
    .description("Cloudflare setup, audit, and teardown helpers");

  const teardown = cloudflare
    .command("teardown")
    .description("Plan Cloudflare resource teardown");

  teardown
    .command("plan")
    .description("Create a read-only Cloudflare teardown plan")
    .option(
      "--include-r2",
      "Include R2 bucket discovery in the read-only plan; no deletion is performed",
    )
    .action(async (options, command) => {
      await deps.withContext(
        command,
        "cloudflare teardown plan",
        async (ctx) => {
          const plan = await ctx.hub.system.createCloudflareTeardownPlan({
            include_r2: !!options.includeR2,
          });
          return summarizePlan(plan);
        },
      );
    });

  teardown
    .command("review <plan-id>")
    .description("Review a saved Cloudflare teardown plan")
    .option(
      "--resources",
      "Show resource classification rows instead of summary",
    )
    .action(async (planId, options, command) => {
      await deps.withContext(
        command,
        "cloudflare teardown review",
        async (ctx) => {
          const plan = await ctx.hub.system.getCloudflareTeardownPlan({
            plan_id: planId,
          });
          return options.resources
            ? summarizeResources(plan)
            : summarizePlan(plan);
        },
      );
    });

  const r2 = cloudflare
    .command("r2")
    .description("Cloudflare R2 usage and audit helpers");

  r2.command("usage")
    .description("Show configured Cloudflare R2 bucket usage")
    .option(
      "--all",
      "Show all visible R2 buckets instead of only buckets matching configured r2_bucket_prefix",
    )
    .option("--summary", "Show account-level summary instead of bucket rows")
    .action(async (options, command) => {
      await deps.withContext(command, "cloudflare r2 usage", async (ctx) => {
        const result = await ctx.hub.system.getCloudflareR2Usage({
          all_buckets: !!options.all,
        });
        return options.summary ? summarizeR2Usage(result) : r2UsageRows(result);
      });
    });

  r2.command("audit <bucket>")
    .description("Scan an R2 bucket via S3 listing and summarize CoCalc usage")
    .option("--prefix <prefix>", "Only audit keys with this prefix")
    .option("--refresh", "Ignore cached audit data and rescan the bucket")
    .option(
      "--max-age-minutes <minutes>",
      "Use cached audit data if it is this many minutes old or newer",
      parseNonNegativeInt,
    )
    .option("--categories", "Show category rows instead of the summary")
    .option("--top-prefixes", "Show top object-key prefix rows")
    .option("--top-objects", "Show largest object rows")
    .action(async (bucket, options, command) => {
      await deps.withContext(command, "cloudflare r2 audit", async (ctx) => {
        const result = await ctx.hub.system.auditCloudflareR2Bucket({
          bucket,
          prefix: options.prefix,
          refresh: !!options.refresh,
          max_age_minutes: options.maxAgeMinutes,
        });
        if (options.categories) return r2AuditCategoryRows(result);
        if (options.topPrefixes) return r2AuditPrefixRows(result);
        if (options.topObjects) return r2AuditObjectRows(result);
        return summarizeR2Audit(result);
      });
    });
}
