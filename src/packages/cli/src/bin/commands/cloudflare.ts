import { Command } from "commander";
import { humanSize } from "@cocalc/util/misc";
import { waitForLro } from "../core/lro";

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

function duration(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
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
  const warnings = (result.warnings ?? []).join(" ");
  return (result.buckets ?? []).map((bucket: any, i: number) => ({
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
    warnings: i === 0 ? warnings : "",
  }));
}

function summarizeR2Audit(result: any) {
  const hasRefinedBreakdown =
    Array.isArray(result.rustic_repos) &&
    result.project_backup_index != null &&
    result.rootfs_images != null &&
    result.bay_backup_files != null &&
    result.other != null;
  const rusticRepos = result.rustic_repos ?? [];
  const rusticObjectCount = rusticRepos.reduce(
    (total: number, repo: any) => total + (repo.object_count ?? 0),
    0,
  );
  const rusticTotalBytes = rusticRepos.reduce(
    (total: number, repo: any) => total + (repo.total_bytes ?? 0),
    0,
  );
  const index = result.project_backup_index ?? {};
  const rootfsImages = result.rootfs_images ?? {};
  const bayBackupFiles = result.bay_backup_files ?? {};
  const other = result.other ?? {};
  const indexBytes = index.total_bytes ?? 0;
  const rootfsBytes = rootfsImages.total_bytes ?? 0;
  const bayBackupBytes = bayBackupFiles.total_bytes ?? 0;
  const otherBytes = other.total_bytes ?? 0;
  const breakdownTotalBytes =
    rusticTotalBytes + indexBytes + rootfsBytes + bayBackupBytes + otherBytes;
  const breakdownDeltaBytes =
    typeof result.total_bytes === "number"
      ? result.total_bytes - breakdownTotalBytes
      : undefined;
  const warnings = [...(result.warnings ?? [])];
  if (!hasRefinedBreakdown) {
    warnings.push(
      "refined audit breakdown unavailable; rebuild/restart the hub and rerun with --refresh",
    );
  }
  return {
    audit_schema_version: result.audit_schema_version ?? "",
    bucket: result.bucket,
    prefix: result.prefix ?? "",
    scanned_at: result.scanned_at,
    cache_hit: result.cache?.hit ?? false,
    cache_expires_at: result.cache?.expires_at ?? "",
    objects: result.object_count ?? 0,
    total: bytes(result.total_bytes),
    rustic_repos: rusticRepos.length,
    rustic_objects: rusticObjectCount,
    rustic_total: bytes(rusticTotalBytes),
    index_files: index.object_count ?? 0,
    index_total: bytes(indexBytes),
    rootfs_image_objects: rootfsImages.object_count ?? 0,
    rootfs_image_total: bytes(rootfsBytes),
    bay_backup_objects: bayBackupFiles.object_count ?? 0,
    bay_backup_total: bytes(bayBackupBytes),
    other_objects: other.object_count ?? 0,
    other_total: bytes(otherBytes),
    breakdown_total: hasRefinedBreakdown ? bytes(breakdownTotalBytes) : "",
    breakdown_matches_total: hasRefinedBreakdown
      ? breakdownDeltaBytes === 0
      : "",
    breakdown_delta: hasRefinedBreakdown ? bytes(breakdownDeltaBytes) : "",
    db_purpose: result.database?.purpose ?? "",
    db_region: result.database?.region ?? "",
    db_projects: result.database?.assigned_projects ?? "",
    warnings: warnings.join(" "),
    notes: (result.notes ?? []).join(" "),
  };
}

function r2AuditRusticRepoRows(result: any) {
  return (result.rustic_repos ?? []).map((row: any) => ({
    repo: row.repo,
    kind: row.kind,
    objects: row.object_count,
    total: bytes(row.total_bytes),
    examples: (row.examples ?? []).join(" "),
  }));
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

function r2AuditOtherPrefixRows(result: any) {
  return (result.other_prefixes ?? []).map((row: any) => ({
    prefix: row.prefix,
    objects: row.object_count,
    total: bytes(row.total_bytes),
  }));
}

function parseNonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("expected a nonnegative integer");
  }
  return n;
}

function isJsonOutput(ctx: any): boolean {
  return !!ctx.globals?.json || ctx.globals?.output === "json";
}

function reportProgress(ctx: any, message: string): void {
  if (isJsonOutput(ctx) || ctx.globals?.quiet) return;
  process.stderr.write(`${message}\n`);
}

function formatR2AuditProgress(progress: any): string | undefined {
  if (!progress || typeof progress !== "object") return undefined;
  if (!progress.bucket && !progress.objects_seen && !progress.bytes_seen) {
    return undefined;
  }
  const bucket = progress.bucket ? `${progress.bucket}` : "R2 bucket";
  const phase = progress.phase ?? "scanning";
  const objects = Number(progress.objects_seen ?? 0);
  const expectedObjects = Number(progress.expected_total_objects);
  const objectLabel =
    Number.isFinite(expectedObjects) && expectedObjects > 0
      ? `${objects}/${expectedObjects} objects`
      : `${objects} objects`;
  const pages = Number(progress.pages_seen ?? 0);
  const seen = bytes(Number(progress.bytes_seen ?? 0)) || "0 B";
  const expectedBytes = Number(progress.expected_total_bytes);
  const expected =
    Number.isFinite(expectedBytes) && expectedBytes > 0
      ? ` / ${bytes(expectedBytes)}`
      : "";
  const progressFraction = Number(progress.progress);
  const percent =
    Number.isFinite(progressFraction) && progressFraction >= 0
      ? ` (${Math.min(100, Math.max(0, progressFraction * 100)).toFixed(1)}%)`
      : "";
  const rateBytes = Number(progress.bytes_per_second);
  const rate =
    Number.isFinite(rateBytes) && rateBytes > 0
      ? `, ${bytes(rateBytes)}/s`
      : "";
  const etaValue = duration(Number(progress.eta_seconds));
  const eta = etaValue ? `, eta ${etaValue}` : "";
  return `${phase} ${bucket}: ${objectLabel}, ${seen}${expected}${percent}, ${pages} pages${rate}${eta}`;
}

async function withScanTimeout<T>(
  ctx: any,
  timeoutMinutes: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const minutes = Math.max(1, timeoutMinutes ?? 360);
  const timeoutMs = minutes * 60 * 1000;
  const prevTimeoutMs = ctx.timeoutMs;
  const prevRpcTimeoutMs = ctx.rpcTimeoutMs;
  ctx.timeoutMs = Math.max(prevTimeoutMs ?? 0, timeoutMs);
  ctx.rpcTimeoutMs = Math.max(prevRpcTimeoutMs ?? 0, timeoutMs);
  try {
    return await fn();
  } finally {
    ctx.timeoutMs = prevTimeoutMs;
    ctx.rpcTimeoutMs = prevRpcTimeoutMs;
  }
}

async function runR2AuditRefresh(ctx: any, bucket: string, options: any) {
  const timeoutMinutes = Math.max(1, options.scanTimeoutMinutes ?? 360);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const op = await ctx.hub.system.startCloudflareR2Audit({
    bucket,
    prefix: options.prefix,
    refresh: true,
    max_age_minutes: options.maxAgeMinutes,
  });
  reportProgress(
    ctx,
    `scanning R2 bucket ${bucket}; timeout is ${timeoutMinutes} minutes; op_id=${op.op_id}`,
  );
  const waited = await waitForLro({
    hub: ctx.hub,
    opId: op.op_id,
    timeoutMs,
    pollMs: Math.max(1000, ctx.pollMs ?? 1000),
    terminalStatuses: new Set(["succeeded", "failed", "canceled", "expired"]),
    onUpdate: async (update) => {
      const message = formatR2AuditProgress(update.progress_summary);
      if (message) reportProgress(ctx, message);
    },
  });
  if (waited.timedOut) {
    throw new Error(
      `timeout waiting for R2 audit operation ${op.op_id} (${timeoutMinutes} minutes)`,
    );
  }
  if (waited.status !== "succeeded") {
    throw new Error(
      waited.error ||
        `R2 audit operation ${op.op_id} finished with status ${waited.status}`,
    );
  }
  return waited.result;
}

function recomputeR2UsageTotals(result: any): void {
  const sum = (field: string) => {
    let total = 0;
    let seen = false;
    for (const bucket of result.buckets ?? []) {
      const value = bucket[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
        seen = true;
      }
    }
    return seen ? total : undefined;
  };

  result.totals = {
    object_count: sum("object_count"),
    payload_bytes: sum("payload_bytes"),
    metadata_bytes: sum("metadata_bytes"),
    total_bytes: sum("total_bytes"),
    upload_count: sum("upload_count"),
  };
}

async function runR2UsageScan(ctx: any, options: any): Promise<any> {
  const result = await ctx.hub.system.getCloudflareR2Usage({
    all_buckets: !!options.all,
    scan: false,
    refresh: false,
    max_age_minutes: options.maxAgeMinutes,
  });
  const buckets = result.buckets ?? [];
  if (buckets.length === 0) return result;

  const timeoutMinutes = Math.max(1, options.scanTimeoutMinutes ?? 360);
  await withScanTimeout(ctx, timeoutMinutes, async () => {
    reportProgress(
      ctx,
      `scanning ${buckets.length} R2 bucket${buckets.length === 1 ? "" : "s"} via S3 listings; per-bucket timeout is ${timeoutMinutes} minutes`,
    );
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i];
      const label = `${i + 1}/${buckets.length}`;
      reportProgress(ctx, `scanning R2 bucket ${label}: ${bucket.bucket}`);
      const started = Date.now();
      const audit = await ctx.hub.system.auditCloudflareR2Bucket({
        bucket: bucket.bucket,
        refresh: !!options.refresh,
        max_age_minutes: options.maxAgeMinutes,
      });
      bucket.object_count = audit.object_count;
      bucket.payload_bytes = audit.total_bytes;
      bucket.total_bytes = audit.total_bytes;
      bucket.measured_at = audit.scanned_at;
      bucket.metrics_source = audit.cache?.hit ? "s3-cache" : "s3-scan";
      bucket.database = audit.database ?? bucket.database;
      if (Array.isArray(audit.warnings) && audit.warnings.length > 0) {
        result.warnings = [...(result.warnings ?? []), ...audit.warnings];
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      reportProgress(
        ctx,
        `finished R2 bucket ${label}: ${bucket.bucket} (${audit.object_count} objects, ${bytes(audit.total_bytes)}, ${audit.cache?.hit ? "cache" : "scan"}, ${seconds}s)`,
      );
    }
  });

  result.buckets = buckets.sort(
    (a: any, b: any) => (b.total_bytes ?? -1) - (a.total_bytes ?? -1),
  );
  recomputeR2UsageTotals(result);
  result.checked_at = new Date().toISOString();
  result.notes = [
    ...(result.notes ?? []),
    "Exact usage was refreshed by scanning each selected bucket via S3 listings.",
  ];
  return result;
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
    .option(
      "--scan",
      "Force exact S3 listing totals; useful with --all when GraphQL analytics is unavailable",
    )
    .option(
      "--no-s3-scan",
      "Disable the default exact S3 listing fallback for prefix-filtered usage",
    )
    .option("--refresh", "Ignore cached S3 usage data and rescan buckets")
    .option(
      "--max-age-minutes <minutes>",
      "Use cached S3 usage data if it is this many minutes old or newer",
      parseNonNegativeInt,
    )
    .option(
      "--scan-timeout-minutes <minutes>",
      "Maximum time to wait for each scanned bucket",
      parseNonNegativeInt,
      360,
    )
    .option("--summary", "Show account-level summary instead of bucket rows")
    .action(async (options, command) => {
      await deps.withContext(command, "cloudflare r2 usage", async (ctx) => {
        const result = options.scan
          ? await runR2UsageScan(ctx, options)
          : await ctx.hub.system.getCloudflareR2Usage({
              all_buckets: !!options.all,
              scan: options.s3Scan === false ? false : undefined,
              refresh: !!options.refresh,
              max_age_minutes: options.maxAgeMinutes,
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
    .option(
      "--scan-timeout-minutes <minutes>",
      "Maximum time to wait for the bucket scan",
      parseNonNegativeInt,
      360,
    )
    .option("--categories", "Show category rows instead of the summary")
    .option("--rustic-repos", "Show per-rustic-repository usage rows")
    .option("--other-prefixes", "Show top non-rustic, non-index prefix rows")
    .option("--top-prefixes", "Show top object-key prefix rows")
    .option("--top-objects", "Show largest object rows")
    .action(async (bucket, options, command) => {
      await deps.withContext(command, "cloudflare r2 audit", async (ctx) => {
        const result = options.refresh
          ? await runR2AuditRefresh(ctx, bucket, options)
          : await withScanTimeout(
              ctx,
              options.scanTimeoutMinutes,
              async () =>
                await ctx.hub.system.auditCloudflareR2Bucket({
                  bucket,
                  prefix: options.prefix,
                  refresh: false,
                  max_age_minutes: options.maxAgeMinutes,
                }),
            );
        if (options.categories) return r2AuditCategoryRows(result);
        if (options.rusticRepos) return r2AuditRusticRepoRows(result);
        if (options.otherPrefixes) return r2AuditOtherPrefixRows(result);
        if (options.topPrefixes) return r2AuditPrefixRows(result);
        if (options.topObjects) return r2AuditObjectRows(result);
        return summarizeR2Audit(result);
      });
    });
}
