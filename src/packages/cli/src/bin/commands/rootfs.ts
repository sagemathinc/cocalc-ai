import { readFileSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import type {
  RootfsConfigExport,
  RootfsAdminCatalogEntry,
  RootfsDeleteRequestResult,
  RootfsImageEntry,
  RootfsImageEvent,
  RootfsImageSection,
  RootfsImageTheme,
  RootfsImageVisibility,
  RootfsReleaseGcRunResult,
  RootfsRusticRepoListResult,
} from "@cocalc/util/rootfs-images";
import { parseRootfsConfigExport } from "@cocalc/util/rootfs-images";
import type { RootfsReleaseScanRun } from "@cocalc/util/rootfs-scan";
import {
  explainRootfsRecipe,
  runRootfsRecipe,
  type RootfsRecipeRunOptions,
} from "./rootfs-recipe";

export type RootfsCommandDeps = {
  withContext: any;
  resolveProjectFromArgOrContext: any;
  resolveProjectProjectApi: any;
  waitForLro: any;
  serializeLroSummary: any;
};

function parseLimit(value?: string, fallback = 100): number {
  return Math.max(1, Math.min(10_000, Number(value ?? fallback) || fallback));
}

function bytes(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let x = n;
  let unit = 0;
  while (x >= 1024 && unit < units.length - 1) {
    x /= 1024;
    unit += 1;
  }
  return `${x.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseVisibility(value?: string): RootfsImageVisibility | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "private" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid visibility '${value}'; expected private, collaborators, or public`,
  );
}

function parseTags(value?: string): string[] | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  const tags = Array.from(
    new Set(
      trimmed
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
  return tags.length ? tags : undefined;
}

function parseThemeJson(value?: string): RootfsImageTheme | undefined {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid --theme-json: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--theme-json must be a JSON object");
  }
  return parsed as RootfsImageTheme;
}

function parseRootfsConfigFile(value?: string): RootfsConfigExport | undefined {
  const path = `${value ?? ""}`.trim();
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`invalid --config-file: ${err}`);
  }
  try {
    return parseRootfsConfigExport(parsed);
  } catch (err) {
    throw new Error(`invalid --config-file: ${err}`);
  }
}

function rootfsCatalogConfigPayload(
  opts: {
    label?: string;
    slug?: string;
    family?: string;
    imageVersion?: string;
    channel?: string;
    supersedesImageId?: string;
    description?: string;
    visibility?: string;
    tags?: string;
    themeJson?: string;
  },
  config?: RootfsConfigExport,
) {
  const label = `${opts.label ?? config?.metadata?.label ?? ""}`.trim();
  if (!label) {
    throw new Error("missing RootFS label; pass --label or --config-file");
  }
  const content =
    config?.content != null
      ? { content: config.content, content_warnings: [] }
      : {};
  return {
    label,
    slug: opts.slug ?? config?.metadata?.slug,
    family: opts.family ?? config?.metadata?.family,
    version: opts.imageVersion ?? config?.metadata?.version,
    channel: opts.channel ?? config?.metadata?.channel,
    supersedes_image_id:
      opts.supersedesImageId ?? config?.metadata?.supersedes_image_id,
    description: opts.description ?? config?.metadata?.description,
    visibility:
      opts.visibility != null
        ? parseVisibility(opts.visibility)
        : config?.metadata?.visibility,
    tags: opts.tags != null ? parseTags(opts.tags) : config?.metadata?.tags,
    theme:
      opts.themeJson != null ? parseThemeJson(opts.themeJson) : config?.theme,
    ...content,
  };
}

function normalizeSection(value?: string): RootfsImageSection | undefined {
  const trimmed = `${value ?? ""}`.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (
    trimmed === "official" ||
    trimmed === "mine" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  throw new Error(
    `invalid section '${value}'; expected official, mine, collaborators, or public`,
  );
}

function serializeRootfsImageEntry(entry: RootfsImageEntry) {
  return {
    image_id: entry.id,
    slug: entry.slug ?? null,
    label: entry.label,
    image: entry.image,
    family: entry.family ?? null,
    version: entry.version ?? null,
    channel: entry.channel ?? null,
    supersedes_image_id: entry.supersedes_image_id ?? null,
    section: entry.section ?? null,
    visibility: entry.visibility ?? null,
    official: !!entry.official,
    prepull: !!entry.prepull,
    hidden: !!entry.hidden,
    blocked: !!entry.blocked,
    blocked_reason: entry.blocked_reason ?? null,
    digest: entry.digest ?? null,
    arch: entry.arch ?? null,
    gpu: !!entry.gpu,
    size_gb: entry.size_gb ?? null,
    owner_id: entry.owner_id ?? null,
    owner_name: entry.owner_name ?? null,
    warning: entry.warning ?? null,
    description: entry.description ?? null,
    tags: entry.tags ?? [],
    can_manage: !!entry.can_manage,
    scan: entry.scan ?? null,
  };
}

function serializeRootfsAdminEntry(entry: RootfsAdminCatalogEntry) {
  return {
    ...serializeRootfsImageEntry(entry),
    deleted: !!entry.deleted,
    deleted_reason: entry.deleted_reason ?? null,
    hidden_at: entry.hidden_at ?? null,
    hidden_by: entry.hidden_by ?? null,
    blocked_at: entry.blocked_at ?? null,
    blocked_by: entry.blocked_by ?? null,
    deleted_at: entry.deleted_at ?? null,
    deleted_by: entry.deleted_by ?? null,
    release_id: entry.release_id ?? null,
    release_gc_status: entry.release_gc_status ?? null,
    storage_locations: entry.storage_locations ?? [],
    delete_blockers: entry.delete_blockers ?? null,
    scan_status: entry.scan_status ?? null,
    scan_tool: entry.scan_tool ?? null,
    scanned_at: entry.scanned_at ?? null,
    events: entry.events ?? [],
  };
}

function formatRootfsEventHuman(event: RootfsImageEvent): string {
  const who = event.actor_name ?? event.actor_account_id ?? "-";
  const details =
    event.reason ??
    event.payload?.blocked_reason ??
    (event.payload?.blockers?.total != null
      ? `blockers=${event.payload.blockers.total}`
      : "");
  return `${event.created} ${event.event_type} by ${who}${details ? ` (${details})` : ""}`;
}

function wrapField({
  label,
  value,
  indent = "   ",
  width = 96,
}: {
  label: string;
  value?: unknown;
  indent?: string;
  width?: number;
}): string[] {
  const text = `${value ?? ""}`.trim();
  if (!text) return [];
  const prefix = `${indent}${label}: `;
  const maxWidth = Math.max(prefix.length + 10, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = prefix;
  for (const word of words) {
    const candidate =
      current === prefix ? `${prefix}${word}` : `${current} ${word}`;
    if (candidate.length <= maxWidth || current === prefix) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = `${" ".repeat(prefix.length)}${word}`;
  }
  lines.push(current);
  return lines;
}

function formatRootfsEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsImageEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   section: ${entry.section ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   flags: official=${entry.official} prepull=${entry.prepull} hidden=${entry.hidden} blocked=${entry.blocked} gpu=${entry.gpu} can_manage=${entry.can_manage}`,
      ];
      if (entry.arch != null) {
        const arch = Array.isArray(entry.arch)
          ? entry.arch.join(", ")
          : `${entry.arch}`;
        lines.push(`   arch: ${arch}`);
      }
      if (entry.digest) {
        lines.push(`   digest: ${entry.digest}`);
      }
      if (entry.family || entry.version || entry.channel) {
        lines.push(
          `   release: family=${entry.family ?? "-"} version=${entry.version ?? "-"} channel=${entry.channel ?? "-"}`,
        );
      }
      if (entry.supersedes_image_id) {
        lines.push(`   supersedes: ${entry.supersedes_image_id}`);
      }
      if (entry.size_gb != null) {
        lines.push(`   size_gb: ${entry.size_gb}`);
      }
      if (entry.warning && entry.warning !== "none") {
        lines.push(`   warning: ${entry.warning}`);
      }
      if (entry.scan?.status && entry.scan.status !== "unknown") {
        lines.push(
          `   scan: status=${entry.scan.status} tool=${entry.scan.tool ?? "-"} scanned_at=${entry.scan.scanned_at ?? "-"}`,
        );
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsAdminEntriesHuman(
  entries: Array<ReturnType<typeof serializeRootfsAdminEntry>>,
): string {
  if (!entries.length) {
    return "(no rootfs images)";
  }
  return entries
    .map((entry, index) => {
      const header = `${index + 1}. ${entry.label}`;
      const lines = [
        header,
        `   id: ${entry.image_id}`,
        `   image: ${entry.image}`,
        `   owner: ${entry.owner_name ?? entry.owner_id ?? "-"}`,
        `   visibility: ${entry.visibility ?? "-"}`,
        `   release_id: ${entry.release_id ?? "-"}`,
        `   lifecycle: hidden=${entry.hidden} blocked=${entry.blocked} deleted=${entry.deleted} release_gc_status=${entry.release_gc_status ?? "-"}`,
      ];
      if (entry.blocked && entry.blocked_reason) {
        lines.push(`   blocked_reason: ${entry.blocked_reason}`);
      }
      if (entry.family || entry.version || entry.channel) {
        lines.push(
          `   release: family=${entry.family ?? "-"} version=${entry.version ?? "-"} channel=${entry.channel ?? "-"}`,
        );
      }
      if (entry.supersedes_image_id) {
        lines.push(`   supersedes: ${entry.supersedes_image_id}`);
      }
      if (entry.blocked_at || entry.blocked_by) {
        lines.push(
          `   last_blocked: ${entry.blocked_at ?? "-"} by ${entry.blocked_by ?? "-"}`,
        );
      }
      if (entry.hidden_at || entry.hidden_by) {
        lines.push(
          `   last_hidden: ${entry.hidden_at ?? "-"} by ${entry.hidden_by ?? "-"}`,
        );
      }
      if (entry.deleted_at || entry.deleted_by) {
        lines.push(
          `   deleted_at: ${entry.deleted_at ?? "-"} by ${entry.deleted_by ?? "-"}`,
        );
      }
      if (entry.delete_blockers) {
        lines.push(
          `   delete_blockers: total=${entry.delete_blockers.total} projects=${entry.delete_blockers.projects_using_release} catalog=${entry.delete_blockers.catalog_entries_using_release} prepull=${entry.delete_blockers.prepull_entries_using_release} child_releases=${entry.delete_blockers.child_releases}`,
        );
      }
      if (entry.scan_status || entry.scan_tool || entry.scanned_at) {
        lines.push(
          `   scan: status=${entry.scan_status ?? "unknown"} tool=${entry.scan_tool ?? "-"} scanned_at=${entry.scanned_at ?? "-"}`,
        );
      }
      if (entry.scan?.summary) {
        lines.push(`   scan_summary: ${entry.scan.summary}`);
      }
      if (entry.scan?.report_url) {
        lines.push(`   scan_report: ${entry.scan.report_url}`);
      }
      if (entry.storage_locations?.length) {
        lines.push("   storage:");
        for (const location of entry.storage_locations) {
          const parts = [
            location.role,
            location.repo_selector ?? location.backend,
          ];
          if (location.region) parts.push(`region=${location.region}`);
          if (location.repo_id) parts.push(`repo_id=${location.repo_id}`);
          if (location.status) parts.push(`status=${location.status}`);
          lines.push(`     - ${parts.join(" ")}`);
        }
      }
      if (entry.events?.length) {
        lines.push("   recent_events:");
        for (const event of entry.events) {
          lines.push(`     - ${formatRootfsEventHuman(event)}`);
        }
      }
      lines.push(
        ...wrapField({
          label: "description",
          value: entry.description,
        }),
      );
      lines.push(
        ...wrapField({
          label: "tags",
          value: Array.isArray(entry.tags) ? entry.tags.join(", ") : "",
        }),
      );
      return lines.join("\n");
    })
    .join("\n\n");
}

function formatRootfsDeleteResultHuman(
  result: RootfsDeleteRequestResult,
): string {
  const lines = [
    `image_id: ${result.image_id}`,
    `image: ${result.image}`,
    `hidden: ${result.hidden}`,
    `deleted: ${result.deleted}`,
    `delete_requested: ${result.delete_requested}`,
    `release_id: ${result.release_id ?? "-"}`,
    `release_gc_status: ${result.release_gc_status ?? "-"}`,
    `blockers: total=${result.blockers.total} projects=${result.blockers.projects_using_release} catalog=${result.blockers.catalog_entries_using_release} prepull=${result.blockers.prepull_entries_using_release} child_releases=${result.blockers.child_releases}`,
  ];
  return lines.join("\n");
}

function formatRootfsGcResultHuman(result: RootfsReleaseGcRunResult): string {
  const lines = [
    `scanned: ${result.scanned}`,
    `deleted: ${result.deleted}`,
    `blocked: ${result.blocked}`,
    `failed: ${result.failed}`,
  ];
  for (const item of result.items) {
    lines.push(
      "",
      `${item.release_id} ${item.status} ${item.image || item.content_key}`,
    );
    if (item.deleted_replicas != null) {
      lines.push(`  deleted_replicas: ${item.deleted_replicas}`);
    }
    if (item.blockers) {
      lines.push(
        `  blockers: total=${item.blockers.total} projects=${item.blockers.projects_using_release} catalog=${item.blockers.catalog_entries_using_release} prepull=${item.blockers.prepull_entries_using_release} child_releases=${item.blockers.child_releases}`,
      );
    }
    if (item.error) {
      lines.push(`  error: ${item.error}`);
    }
  }
  return lines.join("\n");
}

function formatRootfsRusticReposHuman(
  result: RootfsRusticRepoListResult,
): string {
  const byRegion = new Map<string, typeof result.repos>();
  for (const repo of result.repos) {
    const region = repo.region || "unknown";
    const rows = byRegion.get(region) ?? [];
    rows.push(repo);
    byRegion.set(region, rows);
  }
  const lines = [
    `active_shards_per_region: ${result.active_shards_per_region}`,
    `releases_per_shard: ${result.releases_per_shard}`,
    `repos: ${result.repos.length}`,
    "status: active accepts new artifacts; sealed is read-only; draining is operator repair/migration; disabled is unavailable for assignment.",
  ];
  if (
    result.legacy.artifact_count > 0 ||
    result.legacy.r2_object_count != null
  ) {
    lines.push(
      `legacy_single_repo: ${result.legacy.artifact_count} DB artifacts, ${bytes(result.legacy.artifact_bytes)} DB bytes${result.legacy.r2_object_count != null ? `; R2 ${result.legacy.r2_object_count} objects, ${bytes(result.legacy.r2_total_bytes)}` : ""}; temporary read compatibility is still in use`,
    );
  }
  if (result.orphan_r2_repos?.length) {
    lines.push("orphan_r2_rootfs_repos:");
    for (const repo of result.orphan_r2_repos) {
      lines.push(
        `  - ${repo.repo} bucket=${repo.bucket_name ?? "-"} objects=${repo.object_count} total=${bytes(repo.total_bytes)}`,
      );
    }
  }
  for (const [region, repos] of [...byRegion.entries()].sort()) {
    lines.push("", `region ${region}:`);
    for (const repo of repos) {
      const r2 =
        repo.r2_object_count != null
          ? `; R2 ${repo.r2_object_count} objects, ${bytes(repo.r2_total_bytes)}`
          : "";
      lines.push(
        `  ${repo.status} ${repo.assigned_artifact_count}/${repo.cap} (${repo.available_slots} slots free, ${bytes(repo.artifact_bytes)} DB bytes${r2})`,
        `    repo_id: ${repo.id}`,
        `    root: ${repo.root}`,
      );
      if (repo.bucket_name || repo.bucket_id) {
        lines.push(
          `    bucket: ${repo.bucket_name ?? "-"}${repo.bucket_id ? ` (${repo.bucket_id})` : ""}`,
        );
      }
      lines.push(`    updated: ${repo.updated ?? "-"}`);
    }
  }
  return lines.join("\n");
}

async function enrichRootfsRusticReposWithR2Audit({
  ctx,
  result,
  refresh,
  maxAgeMinutes,
}: {
  ctx: any;
  result: RootfsRusticRepoListResult;
  refresh?: boolean;
  maxAgeMinutes?: number;
}): Promise<RootfsRusticRepoListResult> {
  const repos = result.repos.map((repo) => ({ ...repo }));
  const knownRoots = new Set(repos.map((repo) => repo.root).filter(Boolean));
  const byRoot = new Map(repos.map((repo) => [repo.root, repo]));
  const buckets = Array.from(
    new Set(repos.map((repo) => repo.bucket_name).filter(Boolean)),
  );
  const orphan_r2_repos: NonNullable<
    RootfsRusticRepoListResult["orphan_r2_repos"]
  > = [];
  const legacy = { ...result.legacy };
  for (const bucket of buckets) {
    const audit = await ctx.hub.system.auditCloudflareR2Bucket({
      bucket,
      prefix: "rustic/rootfs-images",
      refresh,
      max_age_minutes: maxAgeMinutes,
    });
    for (const row of audit.rustic_repos ?? []) {
      if (row.kind !== "rootfs") continue;
      const repo = `${row.repo ?? ""}`.trim();
      if (repo === "rustic/rootfs-images") {
        legacy.r2_object_count =
          (legacy.r2_object_count ?? 0) + Number(row.object_count ?? 0);
        legacy.r2_total_bytes =
          (legacy.r2_total_bytes ?? 0) + Number(row.total_bytes ?? 0);
        continue;
      }
      const match = byRoot.get(repo);
      if (match) {
        match.r2_object_count =
          (match.r2_object_count ?? 0) + Number(row.object_count ?? 0);
        match.r2_total_bytes =
          (match.r2_total_bytes ?? 0) + Number(row.total_bytes ?? 0);
      } else if (!knownRoots.has(repo)) {
        orphan_r2_repos.push({
          bucket_name: bucket,
          repo,
          object_count: Number(row.object_count ?? 0),
          total_bytes: Number(row.total_bytes ?? 0),
        });
      }
    }
  }
  return {
    ...result,
    repos,
    legacy,
    orphan_r2_repos,
  };
}

function formatRootfsScanResultHuman(result: RootfsReleaseScanRun): string {
  const counts = result.severity_counts ?? result.summary?.severity_counts;
  const lines = [
    `scan_run_id: ${result.scan_run_id}`,
    `release_id: ${result.release_id}`,
    `image: ${result.runtime_image}`,
    `status: ${result.status}`,
    `host_id: ${result.host_id ?? "-"}`,
    `tool: ${result.tool ?? result.summary?.tool ?? "-"}`,
    `tool_version: ${result.tool_version ?? result.summary?.tool_version ?? "-"}`,
    `db_updated_at: ${result.db_updated_at ?? result.summary?.db?.updated_at ?? "-"}`,
    `requested_at: ${result.requested_at}`,
    `started_at: ${result.started_at ?? "-"}`,
    `completed_at: ${result.completed_at ?? "-"}`,
  ];
  if (counts) {
    lines.push(
      `severity_counts: critical=${counts.critical ?? 0} high=${counts.high ?? 0} medium=${counts.medium ?? 0} low=${counts.low ?? 0} unknown=${counts.unknown ?? 0}`,
    );
  }
  if (result.report_sha256 || result.report_bytes != null) {
    lines.push(
      `report: bytes=${result.report_bytes ?? "-"} compressed_bytes=${result.report_compressed_bytes ?? "-"} sha256=${result.report_sha256 ?? "-"}`,
    );
  }
  const findings = result.summary?.highest_findings ?? [];
  if (findings.length > 0) {
    lines.push("highest_findings:");
    for (const finding of findings) {
      lines.push(
        `  - ${finding.id} ${finding.severity} ${finding.package_name ?? "-"} ${finding.installed_version ?? "-"} -> ${finding.fixed_version ?? "-"}`,
      );
      if (finding.title) {
        lines.push(`    ${finding.title}`);
      }
    }
  }
  if (result.error) {
    lines.push(`error: ${result.error}`);
  }
  return lines.join("\n");
}

function scanCriticalCount(entry: RootfsAdminCatalogEntry): number {
  return entry.scan?.severity_counts?.critical ?? 0;
}

function scanHighCount(entry: RootfsAdminCatalogEntry): number {
  return entry.scan?.severity_counts?.high ?? 0;
}

function isScanStale(
  entry: RootfsAdminCatalogEntry,
  staleDays: number,
): boolean {
  if (!entry.scanned_at) return false;
  const scanned = Date.parse(entry.scanned_at);
  if (!Number.isFinite(scanned)) return false;
  return Date.now() - scanned > staleDays * 24 * 60 * 60 * 1000;
}

function buildRootfsScanAudit(
  entries: RootfsAdminCatalogEntry[],
  staleDays: number,
) {
  const official = entries.filter((entry) => entry.official && !entry.deleted);
  return {
    checked_at: new Date().toISOString(),
    stale_days: staleDays,
    totals: {
      official: official.length,
      unscanned: official.filter(
        (entry) => !entry.scan_status || entry.scan_status === "unknown",
      ).length,
      stale: official.filter((entry) => isScanStale(entry, staleDays)).length,
      failed: official.filter((entry) => entry.scan_status === "error").length,
      findings: official.filter((entry) => entry.scan_status === "findings")
        .length,
      critical: official.filter((entry) => scanCriticalCount(entry) > 0).length,
      high: official.filter((entry) => scanHighCount(entry) > 0).length,
    },
    unscanned: official.filter(
      (entry) => !entry.scan_status || entry.scan_status === "unknown",
    ),
    stale: official.filter((entry) => isScanStale(entry, staleDays)),
    failed: official.filter((entry) => entry.scan_status === "error"),
    findings: official.filter((entry) => entry.scan_status === "findings"),
    critical: official.filter((entry) => scanCriticalCount(entry) > 0),
  };
}

function formatRootfsScanAuditHuman(
  audit: ReturnType<typeof buildRootfsScanAudit>,
): string {
  const lines = [
    `checked_at: ${audit.checked_at}`,
    `official_images: ${audit.totals.official}`,
    `unscanned: ${audit.totals.unscanned}`,
    `stale: ${audit.totals.stale} (>${audit.stale_days} days)`,
    `failed: ${audit.totals.failed}`,
    `findings: ${audit.totals.findings}`,
    `critical: ${audit.totals.critical}`,
    `high: ${audit.totals.high}`,
  ];
  for (const [label, entries] of [
    ["critical", audit.critical],
    ["failed", audit.failed],
    ["unscanned", audit.unscanned],
    ["stale", audit.stale],
  ] as const) {
    if (!entries.length) continue;
    lines.push("", `${label}:`);
    for (const entry of entries) {
      lines.push(
        `  - ${entry.label} image_id=${entry.id} release_id=${entry.release_id ?? "-"} scan=${entry.scan_status ?? "unknown"} scanned_at=${entry.scanned_at ?? "-"}`,
      );
    }
  }
  return lines.join("\n");
}

async function loadAdminRootfsEntryById(ctx: any, image_id: string) {
  const trimmed = `${image_id ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("image_id must be specified");
  }
  const rows: RootfsAdminCatalogEntry[] =
    (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
  const entry = rows.find((row) => row.id === trimmed);
  if (!entry) {
    throw new Error(`rootfs image '${trimmed}' not found`);
  }
  return entry;
}

async function saveAdminRootfsEntry(
  ctx: any,
  entry: RootfsAdminCatalogEntry,
  patch: Partial<RootfsAdminCatalogEntry>,
) {
  return await ctx.hub.system.saveRootfsCatalogEntry({
    image_id: entry.id,
    image: entry.image,
    label: entry.label,
    description: entry.description,
    visibility: entry.visibility,
    arch: entry.arch,
    gpu: entry.gpu,
    size_gb: entry.size_gb,
    tags: entry.tags,
    theme: entry.theme,
    official: patch.official ?? entry.official,
    prepull: patch.prepull ?? entry.prepull,
    hidden: patch.hidden ?? entry.hidden,
    blocked: patch.blocked ?? entry.blocked,
    blocked_reason:
      patch.blocked === false
        ? undefined
        : (patch.blocked_reason ??
          entry.blocked_reason ??
          (patch.blocked ? "Blocked by admin" : undefined)),
  });
}

export function registerRootfsCommand(
  program: Command,
  deps: RootfsCommandDeps,
): Command {
  const {
    withContext,
    resolveProjectFromArgOrContext,
    resolveProjectProjectApi,
    waitForLro,
    serializeLroSummary,
  } = deps;
  const rootfs = program
    .command("rootfs")
    .description("managed RootFS catalog and publish operations");

  const recipe = rootfs
    .command("recipe")
    .description("build RootFS images from local recipe files");

  recipe
    .command("explain <recipe>")
    .description("show resolved RootFS recipe steps and module inputs")
    .option("--module-dir <path>", "local recipe module registry directory")
    .action(
      async (
        recipePath: string,
        opts: { moduleDir?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs recipe explain", async () =>
          explainRootfsRecipe(recipePath, opts.moduleDir),
        );
      },
    );

  recipe
    .command("run <recipe>")
    .description(
      "run a RootFS recipe in a clean builder project or existing project",
    )
    .option("-w, --project <project>", "existing project id or name to use")
    .option("--module-dir <path>", "local recipe module registry directory")
    .option("--title <title>", "title for a new builder project")
    .option("--publish", "publish the resulting project RootFS after running")
    .option(
      "--switch-project",
      "switch the builder project to the published image",
    )
    .option("--wait", "wait for publish completion")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option("--config-out <path>", "write generated RootFS config JSON")
    .action(
      async (
        recipePath: string,
        opts: RootfsRecipeRunOptions,
        command: Command,
      ) => {
        await withContext(command, "rootfs recipe run", async (ctx) => {
          const result = await runRootfsRecipe({
            ctx,
            deps: {
              resolveProjectFromArgOrContext,
              resolveProjectProjectApi,
              waitForLro,
              serializeLroSummary,
            },
            options: opts,
            recipePath,
          });
          if (opts.configOut) {
            writeFileSync(
              opts.configOut,
              `${JSON.stringify(result.config, null, 2)}\n`,
            );
          }
          return result;
        });
      },
    );

  recipe
    .command("verify <recipe>")
    .description("run the top-level verification commands for a RootFS recipe")
    .requiredOption("-w, --project <project>", "project id or name to verify")
    .option("--module-dir <path>", "local recipe module registry directory")
    .action(
      async (
        recipePath: string,
        opts: RootfsRecipeRunOptions,
        command: Command,
      ) => {
        await withContext(command, "rootfs recipe verify", async (ctx) =>
          runRootfsRecipe({
            ctx,
            deps: {
              resolveProjectFromArgOrContext,
              resolveProjectProjectApi,
              waitForLro,
              serializeLroSummary,
            },
            options: {
              ...opts,
              project: opts.project,
              publish: false,
              verifyOnly: true,
            },
            recipePath,
          }),
        );
      },
    );

  rootfs
    .command("list")
    .description("list visible RootFS catalog entries")
    .option(
      "--section <section>",
      "filter by section: official, mine, collaborators, public",
    )
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          section?: string;
          image?: string;
          label?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs list", async (ctx) => {
          const section = normalizeSection(opts.section);
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let images = (await ctx.hub.system.getRootfsCatalog({})).images ?? [];
          if (section) {
            images = images.filter((entry) => entry.section === section);
          }
          if (imageFilter) {
            images = images.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            images = images.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          const rows = images
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsImageEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return rows;
          }
          return formatRootfsEntriesHuman(rows);
        });
      },
    );

  rootfs
    .command("admin-list")
    .description("list all RootFS catalog entries with admin lifecycle details")
    .option("--image <image>", "filter by runtime image name")
    .option("--label <label>", "filter by label substring")
    .option("--include-deleted", "include deleted rows in output")
    .option("--limit <n>", "max rows", "100")
    .action(
      async (
        opts: {
          image?: string;
          label?: string;
          includeDeleted?: boolean;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs admin-list", async (ctx) => {
          const imageFilter = `${opts.image ?? ""}`.trim().toLowerCase();
          const labelFilter = `${opts.label ?? ""}`.trim().toLowerCase();
          let rows: RootfsAdminCatalogEntry[] =
            (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
          if (!opts.includeDeleted) {
            rows = rows.filter((entry) => !entry.deleted);
          }
          if (imageFilter) {
            rows = rows.filter((entry) =>
              `${entry.image ?? ""}`.trim().toLowerCase().includes(imageFilter),
            );
          }
          if (labelFilter) {
            rows = rows.filter((entry) =>
              `${entry.label ?? ""}`.trim().toLowerCase().includes(labelFilter),
            );
          }
          const serialized = rows
            .slice(0, parseLimit(opts.limit))
            .map(serializeRootfsAdminEntry);
          if (ctx.globals.json || ctx.globals.output === "json") {
            return serialized;
          }
          return formatRootfsAdminEntriesHuman(serialized);
        });
      },
    );

  rootfs
    .command("shards")
    .description("list sharded RootFS rustic repositories (admin only)")
    .option("--region <region>", "filter by RootFS/R2 region")
    .option(
      "--status <status>",
      "filter by status: active, sealed, draining, disabled",
    )
    .option("--legacy", "show only legacy single-repo summary")
    .option("--hide-empty", "hide shards with no assigned DB artifacts")
    .option(
      "--r2-audit",
      "enrich shards with R2 object counts and bytes from bucket audit cache",
    )
    .option("--refresh", "force a fresh R2 audit when used with --r2-audit")
    .option(
      "--max-age-minutes <n>",
      "maximum cached R2 audit age when used with --r2-audit",
      "60",
    )
    .action(
      async (
        opts: {
          region?: string;
          status?: string;
          legacy?: boolean;
          hideEmpty?: boolean;
          r2Audit?: boolean;
          refresh?: boolean;
          maxAgeMinutes?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs shards", async (ctx) => {
          let result: RootfsRusticRepoListResult =
            await ctx.hub.system.getRootfsRusticReposAdmin({
              region: opts.region,
              status: opts.status,
            });
          if (opts.r2Audit) {
            result = await enrichRootfsRusticReposWithR2Audit({
              ctx,
              result,
              refresh: opts.refresh,
              maxAgeMinutes: parseLimit(opts.maxAgeMinutes, 60),
            });
          }
          if (opts.legacy) {
            result = { ...result, repos: [] };
          } else if (opts.hideEmpty) {
            result = {
              ...result,
              repos: result.repos.filter(
                (repo) => repo.assigned_artifact_count > 0,
              ),
            };
          }
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsRusticReposHuman(result);
        });
      },
    );

  rootfs
    .command("prepull [host_id]")
    .description(
      "queue RootFS pre-pull reconciliation for all running hosts or one host",
    )
    .option("--limit <n>", "maximum running hosts to queue", "5000")
    .action(
      async (
        hostId: string | undefined,
        opts: { limit?: string },
        command: Command,
      ) => {
        await withContext(command, "rootfs prepull", async (ctx) => {
          return await ctx.hub.system.enqueueRootfsPrepull({
            host_id: `${hostId ?? ""}`.trim() || undefined,
            limit: hostId ? undefined : parseLimit(opts.limit, 5000),
          });
        });
      },
    );

  rootfs
    .command("delete")
    .description("soft-delete a RootFS catalog entry and request safe GC")
    .requiredOption("--image-id <id>", "catalog image id")
    .option(
      "--reason <text>",
      "optional reason recorded with the delete request",
    )
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs delete", async (ctx) => {
          const result = await ctx.hub.system.requestRootfsImageDeletion({
            image_id: `${opts.imageId ?? ""}`.trim(),
            reason: opts.reason,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsDeleteResultHuman(result);
        });
      },
    );

  rootfs
    .command("hide")
    .description("hide a RootFS catalog entry from normal views")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs hide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: true,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unhide")
    .description("make a hidden RootFS catalog entry visible again")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unhide", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            hidden: false,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("block")
    .description("block new use of a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .option("--reason <text>", "optional block reason")
    .action(
      async (
        opts: {
          imageId: string;
          reason?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs block", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: true,
            blocked_reason: opts.reason,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("unblock")
    .description("remove the block from a RootFS catalog entry")
    .requiredOption("--image-id <id>", "catalog image id")
    .action(
      async (
        opts: {
          imageId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs unblock", async (ctx) => {
          const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
          const result = await saveAdminRootfsEntry(ctx, entry, {
            blocked: false,
            blocked_reason: undefined,
          });
          return serializeRootfsImageEntry(result);
        });
      },
    );

  rootfs
    .command("gc")
    .description("garbage collect pending-delete RootFS releases (admin only)")
    .option("--limit <n>", "max pending releases to scan", "10")
    .action(
      async (
        opts: {
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs gc", async (ctx) => {
          const result = await ctx.hub.system.runRootfsReleaseGc({
            limit: parseLimit(opts.limit, 10),
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsGcResultHuman(result);
        });
      },
    );

  rootfs
    .command("scan")
    .description("run an admin Trivy scan for a managed RootFS release")
    .option("--image-id <id>", "catalog image id to scan")
    .option("--release-id <id>", "release id to scan")
    .requiredOption(
      "--host-id <id>",
      "project host that should materialize and scan the RootFS",
    )
    .option(
      "--scanner-image <image>",
      "pinned Trivy scanner container image; defaults to server settings/env",
    )
    .option(
      "--trivy-cache-dir <path>",
      "host-local Trivy DB/cache directory; defaults to server settings/env",
    )
    .option("--timeout-ms <n>", "scan timeout in milliseconds")
    .option("--max-target-bytes <n>", "maximum RootFS target bytes")
    .option("--max-report-bytes <n>", "maximum raw Trivy JSON report bytes")
    .option("--memory-limit <value>", "podman memory limit, e.g. 4g")
    .option("--cpu-limit <value>", "podman CPU limit, e.g. 2")
    .option("--tmpfs-size <value>", "scanner /tmp tmpfs size, e.g. 512m")
    .action(
      async (
        opts: {
          imageId?: string;
          releaseId?: string;
          hostId: string;
          scannerImage?: string;
          trivyCacheDir?: string;
          timeoutMs?: string;
          maxTargetBytes?: string;
          maxReportBytes?: string;
          memoryLimit?: string;
          cpuLimit?: string;
          tmpfsSize?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan", async (ctx) => {
          let release_id = `${opts.releaseId ?? ""}`.trim();
          if (!release_id && opts.imageId) {
            const entry = await loadAdminRootfsEntryById(ctx, opts.imageId);
            release_id = `${entry.release_id ?? ""}`.trim();
            if (!release_id) {
              throw new Error(
                `rootfs image '${opts.imageId}' does not reference a managed release`,
              );
            }
          }
          if (!release_id) {
            throw new Error("specify --release-id or --image-id");
          }
          const result = await ctx.hub.system.scanRootfsRelease({
            release_id,
            host_id: `${opts.hostId ?? ""}`.trim(),
            scanner_image: opts.scannerImage,
            trivy_cache_dir: opts.trivyCacheDir,
            timeout_ms: opts.timeoutMs ? Number(opts.timeoutMs) : undefined,
            max_target_bytes: opts.maxTargetBytes
              ? Number(opts.maxTargetBytes)
              : undefined,
            max_report_bytes: opts.maxReportBytes
              ? Number(opts.maxReportBytes)
              : undefined,
            memory_limit: opts.memoryLimit,
            cpu_limit: opts.cpuLimit,
            tmpfs_size: opts.tmpfsSize,
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return result;
          }
          return formatRootfsScanResultHuman(result);
        });
      },
    );

  rootfs
    .command("scan-report")
    .description("download a retained admin RootFS scan JSON report")
    .requiredOption("--report-id <id>", "scan report artifact id")
    .action(
      async (
        opts: {
          reportId: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan-report", async (ctx) => {
          const report = await ctx.hub.system.getRootfsScanReport({
            report_id: `${opts.reportId ?? ""}`.trim(),
          });
          if (ctx.globals.json || ctx.globals.output === "json") {
            return report;
          }
          return JSON.stringify(report.report_json, null, 2);
        });
      },
    );

  rootfs
    .command("scan-audit")
    .description("summarize official RootFS vulnerability scan coverage")
    .option("--stale-days <n>", "scan age considered stale", "30")
    .action(
      async (
        opts: {
          staleDays?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs scan-audit", async (ctx) => {
          const entries: RootfsAdminCatalogEntry[] =
            (await ctx.hub.system.getRootfsCatalogAdmin({})) ?? [];
          const audit = buildRootfsScanAudit(
            entries,
            parseLimit(opts.staleDays, 30),
          );
          if (ctx.globals.json || ctx.globals.output === "json") {
            return audit;
          }
          return formatRootfsScanAuditHuman(audit);
        });
      },
    );

  rootfs
    .command("save")
    .description("create or update a RootFS catalog entry")
    .requiredOption("--image <image>", "runtime image reference")
    .option("--label <label>", "catalog label")
    .option("--slug <slug>", "public landing page slug")
    .option("--image-id <id>", "update an existing catalog entry by id")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option(
      "--config-file <path>",
      "portable RootFS config JSON exported from the UI or authored by an agent",
    )
    .option("--family <family>", "optional image family for upgrade grouping")
    .option("--image-version <version>", "optional user-facing image version")
    .option("--channel <channel>", "optional release channel, e.g. stable")
    .option(
      "--supersedes-image-id <id>",
      "optional catalog image id superseded by this entry",
    )
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .action(
      async (
        opts: {
          image: string;
          label?: string;
          slug?: string;
          imageId?: string;
          browserId?: string;
          configFile?: string;
          family?: string;
          imageVersion?: string;
          channel?: string;
          supersedesImageId?: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs save", async (ctx) => {
          const config = parseRootfsConfigFile(opts.configFile);
          const payload = rootfsCatalogConfigPayload(opts, config);
          const entry = await ctx.hub.system.saveRootfsCatalogEntry({
            image_id: `${opts.imageId ?? ""}`.trim() || undefined,
            image: opts.image,
            browser_id: `${opts.browserId ?? ""}`.trim() || undefined,
            ...payload,
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
          });
          return serializeRootfsImageEntry(entry);
        });
      },
    );

  rootfs
    .command("publish")
    .description("publish the current RootFS state of a project")
    .option("-w, --project <project>", "project id or name")
    .option("--label <label>", "catalog label for the published image")
    .option("--slug <slug>", "public landing page slug")
    .option("--browser-id <id>", "browser session id for fresh-auth checks")
    .option(
      "--config-file <path>",
      "portable RootFS config JSON exported from the UI or authored by an agent",
    )
    .option("--family <family>", "optional image family for upgrade grouping")
    .option("--image-version <version>", "optional user-facing image version")
    .option("--channel <channel>", "optional release channel, e.g. stable")
    .option(
      "--supersedes-image-id <id>",
      "optional catalog image id superseded by this entry",
    )
    .option("--description <text>", "catalog description")
    .option("--visibility <visibility>", "private, collaborators, or public")
    .option("--tags <csv>", "comma-separated tags")
    .option("--theme-json <json>", "theme metadata as a JSON object")
    .option("--official", "mark as official (admin only)")
    .option("--prepull", "mark for automatic prepull on new hosts (admin only)")
    .option("--hidden", "hide from normal catalog views")
    .option(
      "--switch-project",
      "switch the project to the newly published image when publishing succeeds",
    )
    .option("--wait", "wait for the publish LRO to finish")
    .action(
      async (
        opts: {
          project?: string;
          label?: string;
          slug?: string;
          browserId?: string;
          configFile?: string;
          family?: string;
          imageVersion?: string;
          channel?: string;
          supersedesImageId?: string;
          description?: string;
          visibility?: string;
          tags?: string;
          themeJson?: string;
          official?: boolean;
          prepull?: boolean;
          hidden?: boolean;
          switchProject?: boolean;
          wait?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "rootfs publish", async (ctx) => {
          const ws = await resolveProjectFromArgOrContext(ctx, opts.project);
          const config = parseRootfsConfigFile(opts.configFile);
          const payload = rootfsCatalogConfigPayload(opts, config);
          const op = await ctx.hub.system.publishProjectRootfsImage({
            project_id: ws.project_id,
            browser_id: `${opts.browserId ?? ""}`.trim() || undefined,
            ...payload,
            official: opts.official ? true : undefined,
            prepull: opts.prepull ? true : undefined,
            hidden: opts.hidden ? true : undefined,
            switch_project: opts.switchProject ? true : undefined,
          });
          if (!opts.wait) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              scope_type: op.scope_type,
              scope_id: op.scope_id,
              stream_name: op.stream_name,
              status: "queued",
            };
          }
          const waited = await waitForLro(ctx, op.op_id, {
            timeoutMs: ctx.timeoutMs,
            pollMs: ctx.pollMs,
          });
          if (waited.timedOut) {
            throw new Error(
              `rootfs publish timed out (op=${op.op_id}, last_status=${waited.status})`,
            );
          }
          const summary = await ctx.hub.lro.get({ op_id: op.op_id });
          if (!summary) {
            return {
              project_id: ws.project_id,
              op_id: op.op_id,
              status: waited.status,
              error: waited.error ?? null,
            };
          }
          if (summary.status !== "succeeded") {
            throw new Error(
              `rootfs publish failed: status=${summary.status} error=${summary.error ?? "unknown"}`,
            );
          }
          return serializeLroSummary(summary);
        });
      },
    );

  return rootfs;
}
