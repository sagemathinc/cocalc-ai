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
    r2_buckets_with_usage: summary.counts?.r2_buckets_with_usage ?? "",
    r2_buckets_missing_usage: summary.counts?.r2_buckets_missing_usage ?? "",
    r2_objects: summary.counts?.r2_objects ?? "",
    r2_total: bytes(summary.counts?.r2_total_bytes),
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
    objects: resource.details?.object_count ?? "",
    total: bytes(resource.details?.total_bytes),
    scanned_at: resource.details?.scanned_at ?? "",
    reason: resource.reason ?? "",
  }));
}

function summarizeApplyResult(result: any) {
  return {
    plan_id: result?.plan_id ?? "",
    applied_at: result?.applied_at ?? "",
    deleted_dns_records: result?.deleted_dns_records ?? 0,
    deleted_tunnels: result?.deleted_tunnels ?? 0,
    skipped_r2_buckets: result?.skipped_r2_buckets ?? 0,
    deleted_r2_buckets: result?.deleted_r2_buckets ?? 0,
    deleted_r2_objects: result?.deleted_r2_objects ?? 0,
    deleted_r2_bytes: bytes(result?.deleted_r2_bytes),
    reset_local_settings: result?.reset_local_settings ?? false,
    notes: (result?.notes ?? []).join(" "),
  };
}

function summarizeApplyActions(result: any) {
  return (result?.actions ?? []).map((action: any) => ({
    kind: action.kind ?? "",
    status: action.status ?? "",
    id: action.id ?? "",
    name: action.name ?? "",
    reason: action.reason ?? "",
    error: action.error ?? "",
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

function r2AuditRusticKindRows(result: any) {
  const byKind = new Map<
    string,
    {
      repos: number;
      object_count: number;
      total_bytes: number;
      largest_repo: string;
      largest_repo_bytes: number;
    }
  >();
  for (const repo of result.rustic_repos ?? []) {
    const kind = `${repo.kind ?? "unknown"}`;
    const current = byKind.get(kind) ?? {
      repos: 0,
      object_count: 0,
      total_bytes: 0,
      largest_repo: "",
      largest_repo_bytes: 0,
    };
    const totalBytes = Number(repo.total_bytes ?? 0);
    current.repos += 1;
    current.object_count += Number(repo.object_count ?? 0);
    current.total_bytes += totalBytes;
    if (totalBytes > current.largest_repo_bytes) {
      current.largest_repo = `${repo.repo ?? ""}`;
      current.largest_repo_bytes = totalBytes;
    }
    byKind.set(kind, current);
  }
  return [...byKind.entries()]
    .map(([kind, row]) => ({
      kind,
      repos: row.repos,
      objects: row.object_count,
      total: bytes(row.total_bytes),
      largest_repo: row.largest_repo,
      largest_repo_total: bytes(row.largest_repo_bytes),
    }))
    .sort((a, b) => {
      const aBytes = byKind.get(a.kind)?.total_bytes ?? 0;
      const bBytes = byKind.get(b.kind)?.total_bytes ?? 0;
      return bBytes - aBytes;
    });
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

function summarizeR2BayBackupCleanupPlan(plan: any) {
  return {
    bucket: plan.bucket,
    prefix: plan.prefix,
    checked_at: plan.checked_at,
    objects: plan.object_count ?? 0,
    total: bytes(plan.total_bytes),
    wal_objects: plan.wal_object_count ?? 0,
    wal_total: bytes(plan.wal_total_bytes),
    manifest_objects: plan.manifest_object_count ?? 0,
    manifest_total: bytes(plan.manifest_total_bytes),
    other_objects: plan.other_object_count ?? 0,
    other_total: bytes(plan.other_total_bytes),
    confirmation_text: plan.confirmation_text ?? "",
    warnings: (plan.warnings ?? []).join(" "),
    notes: (plan.notes ?? []).join(" "),
  };
}

function r2BayBackupCleanupPrefixRows(plan: any) {
  return (plan.bay_prefixes ?? []).map((row: any) => ({
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

function formatR2BayBackupCleanupProgress(progress: any): string | undefined {
  if (!progress || typeof progress !== "object") return undefined;
  if (!progress.bucket && !progress.objects_seen && !progress.objects_deleted) {
    return undefined;
  }
  const bucket = progress.bucket ? `${progress.bucket}` : "R2 bucket";
  const prefix = progress.prefix ? `${progress.prefix}` : "bay-backups/";
  const phase = progress.phase ?? "deleting";
  const seen = Number(progress.objects_seen ?? 0);
  const total = Number(progress.objects_total ?? seen);
  const deleted = Number(progress.objects_deleted ?? 0);
  const deletedBytes = bytes(Number(progress.bytes_deleted ?? 0)) || "0 B";
  const rate = Number(progress.objects_per_second);
  const rateText = Number.isFinite(rate) && rate > 0 ? `, ${rate}/s` : "";
  return `${phase} ${bucket}/${prefix}: ${deleted}/${total} objects deleted, ${deletedBytes}${rateText}`;
}

function formatTeardownApplyProgress(progress: any): string | undefined {
  if (!progress || typeof progress !== "object") return undefined;
  if (!progress.plan_id && !progress.phase) return undefined;
  const phase = progress.phase ?? "applying";
  const dnsDeleted = Number(progress.deleted_dns_records ?? 0);
  const dnsTotal = Number(progress.total_dns_records ?? 0);
  const tunnelDeleted = Number(progress.deleted_tunnels ?? 0);
  const tunnelTotal = Number(progress.total_tunnels ?? 0);
  const r2Total = Number(progress.total_r2_buckets ?? 0);
  const r2Deleted = Number(progress.deleted_r2_buckets ?? 0);
  const r2Skipped = Number(progress.skipped_r2_buckets ?? 0);
  const r2ObjectsDeleted = Number(progress.deleted_r2_objects ?? 0);
  const r2ObjectsTotal = Number(progress.total_r2_objects ?? 0);
  const r2BytesDeleted = bytes(Number(progress.deleted_r2_bytes ?? 0));
  const r2BytesTotal = bytes(Number(progress.total_r2_bytes ?? 0));
  const r2Bucket = progress.current_r2_bucket
    ? `, bucket ${progress.current_r2_bucket}`
    : "";
  const r2Text =
    r2Total > 0
      ? `, R2 buckets ${r2Deleted}/${r2Total}, R2 objects ${r2ObjectsDeleted}/${r2ObjectsTotal}, R2 bytes ${r2BytesDeleted || "0 B"}/${r2BytesTotal || "0 B"}${r2Skipped > 0 ? `, ${r2Skipped} R2 buckets skipped` : ""}${r2Bucket}`
      : "";
  return `${phase}: DNS ${dnsDeleted}/${dnsTotal}, tunnels ${tunnelDeleted}/${tunnelTotal}${r2Text}`;
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

async function runR2BayBackupCleanup(ctx: any, bucket: string, options: any) {
  const timeoutMinutes = Math.max(1, options.timeoutMinutes ?? 360);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const op = await ctx.hub.system.startCloudflareR2BayBackupCleanup({
    bucket,
    prefix: options.prefix,
    confirm: options.confirm,
  });
  reportProgress(
    ctx,
    `deleting direct bay backup objects from ${bucket}; timeout is ${timeoutMinutes} minutes; op_id=${op.op_id}`,
  );
  const waited = await waitForLro({
    hub: ctx.hub,
    opId: op.op_id,
    timeoutMs,
    pollMs: Math.max(1000, ctx.pollMs ?? 1000),
    terminalStatuses: new Set(["succeeded", "failed", "canceled", "expired"]),
    onUpdate: async (update) => {
      const message = formatR2BayBackupCleanupProgress(update.progress_summary);
      if (message) reportProgress(ctx, message);
    },
  });
  if (waited.timedOut) {
    throw new Error(
      `timeout waiting for R2 bay backup cleanup operation ${op.op_id} (${timeoutMinutes} minutes)`,
    );
  }
  if (waited.status !== "succeeded") {
    throw new Error(
      waited.error ||
        `R2 bay backup cleanup operation ${op.op_id} finished with status ${waited.status}`,
    );
  }
  return waited.result;
}

async function runTeardownApply(ctx: any, planId: string, options: any) {
  const timeoutMinutes = Math.max(1, options.timeoutMinutes ?? 30);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const op = await ctx.hub.system.startCloudflareTeardownApply({
    plan_id: planId,
    confirm: options.confirm,
    delete_r2_contents: !!options.deleteR2Contents,
    reset_local_settings: !!options.resetLocalSettings,
  });
  reportProgress(
    ctx,
    `applying Cloudflare teardown plan ${planId}; timeout is ${timeoutMinutes} minutes; op_id=${op.op_id}`,
  );
  const waited = await waitForLro({
    hub: ctx.hub,
    opId: op.op_id,
    timeoutMs,
    pollMs: Math.max(1000, ctx.pollMs ?? 1000),
    terminalStatuses: new Set(["succeeded", "failed", "canceled", "expired"]),
    onUpdate: async (update) => {
      const message = formatTeardownApplyProgress(update.progress_summary);
      if (message) reportProgress(ctx, message);
    },
  });
  if (waited.timedOut) {
    throw new Error(
      `timeout waiting for Cloudflare teardown apply operation ${op.op_id} (${timeoutMinutes} minutes)`,
    );
  }
  if (waited.status !== "succeeded") {
    throw new Error(
      waited.error ||
        `Cloudflare teardown apply operation ${op.op_id} finished with status ${waited.status}`,
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

  teardown
    .command("apply <plan-id>")
    .description(
      "Apply a saved Cloudflare teardown plan for safe-owned resources",
    )
    .requiredOption(
      "--confirm <text>",
      "Exact confirmation_text from 'cocalc cloudflare teardown plan'",
    )
    .option(
      "--delete-r2-contents",
      "Delete safe-owned R2 bucket contents and buckets from the saved plan",
    )
    .option(
      "--reset-local-settings",
      "Clear local Cloudflare/R2 site settings after successful Cloudflare-side teardown",
    )
    .option("--actions", "Show per-resource apply actions")
    .option(
      "--timeout-minutes <minutes>",
      "Maximum time to wait for teardown apply",
      parseNonNegativeInt,
      30,
    )
    .action(async (planId, options, command) => {
      await deps.withContext(
        command,
        "cloudflare teardown apply",
        async (ctx) => {
          const result = await runTeardownApply(ctx, planId, options);
          return options.actions
            ? summarizeApplyActions(result)
            : summarizeApplyResult(result);
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
    .option("--rustic-kinds", "Show rustic repository usage grouped by kind")
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
        if (options.rusticKinds) return r2AuditRusticKindRows(result);
        if (options.rusticRepos) return r2AuditRusticRepoRows(result);
        if (options.otherPrefixes) return r2AuditOtherPrefixRows(result);
        if (options.topPrefixes) return r2AuditPrefixRows(result);
        if (options.topObjects) return r2AuditObjectRows(result);
        return summarizeR2Audit(result);
      });
    });

  const bayBackups = r2
    .command("bay-backups")
    .description("Plan or delete direct R2 bay database backup objects");

  bayBackups
    .command("plan <bucket>")
    .description(
      "Scan direct bay-backups/* objects and print the required delete confirmation",
    )
    .option(
      "--prefix <prefix>",
      "Direct bay backup prefix to scan",
      "bay-backups/",
    )
    .option("--prefixes", "Show per-bay-prefix rows")
    .action(async (bucket, options, command) => {
      await deps.withContext(
        command,
        "cloudflare r2 bay-backups plan",
        async (ctx) => {
          const plan = await ctx.hub.system.getCloudflareR2BayBackupCleanupPlan(
            {
              bucket,
              prefix: options.prefix,
            },
          );
          return options.prefixes
            ? r2BayBackupCleanupPrefixRows(plan)
            : summarizeR2BayBackupCleanupPlan(plan);
        },
      );
    });

  bayBackups
    .command("delete <bucket>")
    .description(
      "Delete direct bay-backups/* objects after exact confirmation; does not touch rustic repositories",
    )
    .requiredOption(
      "--confirm <text>",
      "Exact confirmation_text from 'cocalc cloudflare r2 bay-backups plan'",
    )
    .option(
      "--prefix <prefix>",
      "Direct bay backup prefix to delete",
      "bay-backups/",
    )
    .option(
      "--timeout-minutes <minutes>",
      "Maximum time to wait for deletion",
      parseNonNegativeInt,
      360,
    )
    .action(async (bucket, options, command) => {
      await deps.withContext(
        command,
        "cloudflare r2 bay-backups delete",
        async (ctx) =>
          summarizeR2BayBackupCleanupPlan(
            await runR2BayBackupCleanup(ctx, bucket, options),
          ),
      );
    });
}
