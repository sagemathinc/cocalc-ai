/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { posix } from "node:path";
import { Command } from "commander";

import type {
  ProjectStorageBreakdown,
  ProjectStorageCountedSummary,
  ProjectStorageHistory,
  ProjectStorageHistoryPoint,
  ProjectStorageOverview,
  ProjectStorageQuotaSummary,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/project/storage-info";
import {
  getStorageBreakdown,
  getStorageHistory,
  getStorageOverview,
} from "@cocalc/conat/project/storage-info";
import { human_readable_size } from "@cocalc/util/misc";

import type { ProjectCommandDeps } from "../project";

const DEFAULT_HISTORY_WINDOW = "24h";
const DEFAULT_HISTORY_POINTS = 96;

type StorageBucketKey = "home" | "scratch" | "environment";
type StorageMetricKey =
  | "quota"
  | "home"
  | "scratch"
  | "environment"
  | "snapshots";
type StorageFindingSeverity = "info" | "warning" | "error";

interface StorageBucketBreakdownResult {
  key: StorageBucketKey;
  label: string;
  path: string;
  bytes: number;
  collected_at?: string;
  children?: {
    path: string;
    absolute_path: string;
    bytes: number;
    percent: number;
  }[];
  error?: string;
}

interface StorageFinding {
  id: string;
  severity: StorageFindingSeverity;
  message: string;
}

interface StorageRecommendationAction {
  type: "inspect_path" | "open_path" | "run_command";
  path?: string;
  command?: string;
  reason: string;
  caution?: string;
}

interface StorageRecommendation {
  id: string;
  priority: number;
  message: string;
  actions: StorageRecommendationAction[];
}

export interface StorageAnalysisResult {
  project_id: string;
  title: string;
  collected_at: string;
  home_path: string;
  summary: {
    quota: {
      label: string;
      used_bytes: number;
      size_bytes: number;
      used_percent?: number;
      qgroupid?: string;
      scope?: "tracking" | "subvolume";
      warning?: string;
    } | null;
    visible: Record<
      StorageBucketKey,
      {
        label: string;
        path: string;
        bytes: number;
      } | null
    >;
    counted: {
      snapshots: {
        label: string;
        bytes: number;
        detail?: string;
      } | null;
    };
  };
  history: {
    window_minutes: number;
    point_count: number;
    latest_point?: ProjectStorageHistoryPoint;
    growth?: ProjectStorageHistory["growth"];
  };
  breakdowns: StorageBucketBreakdownResult[];
  findings: StorageFinding[];
  recommendations: StorageRecommendation[];
}

function wantsJson(ctx: any): boolean {
  return !!ctx?.globals?.json || ctx?.globals?.output === "json";
}

function quoteCliArg(value: string): string {
  return JSON.stringify(value);
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  return human_readable_size(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  return `${Math.round(value * 10) / 10}%`;
}

function formatRatePerHour(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "?";
  const abs = human_readable_size(Math.abs(value));
  if (value === 0) return "0 bytes/h";
  return `${value > 0 ? "+" : "-"}${abs}/h`;
}

function parseHistoryWindowMinutes(durationToMs: any, raw?: string): number {
  const input =
    `${raw ?? DEFAULT_HISTORY_WINDOW}`.trim() || DEFAULT_HISTORY_WINDOW;
  const ms = Number(durationToMs(input));
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`invalid storage history window: ${input}`);
  }
  return Math.max(60, Math.min(30 * 24 * 60, Math.floor(ms / 60_000)));
}

function parseMaxPoints(parsePositiveInteger: any, raw?: string): number {
  const parsed = parsePositiveInteger(raw, DEFAULT_HISTORY_POINTS, "--points");
  return Math.max(2, Math.min(1440, parsed));
}

function quotaSummary(
  overview: ProjectStorageOverview,
): ProjectStorageQuotaSummary | null {
  return overview.quotas.find((entry) => entry.key === "project") ?? null;
}

function visibleSummary(
  overview: ProjectStorageOverview,
  key: StorageBucketKey,
): ProjectStorageVisibleSummary | null {
  return overview.visible.find((entry) => entry.key === key) ?? null;
}

function countedSummary(
  overview: ProjectStorageOverview,
  key: "snapshots",
): ProjectStorageCountedSummary | null {
  return overview.counted.find((entry) => entry.key === key) ?? null;
}

function metricValue(
  point: ProjectStorageHistoryPoint,
  metric: StorageMetricKey,
): number | undefined {
  switch (metric) {
    case "quota":
      return point.quota_used_bytes;
    case "home":
      return point.home_visible_bytes;
    case "scratch":
      return point.scratch_visible_bytes;
    case "environment":
      return point.environment_visible_bytes;
    case "snapshots":
      return point.snapshot_counted_bytes;
    default:
      return undefined;
  }
}

function computeMetricSlopePerHour(
  points: ProjectStorageHistoryPoint[],
  metric: StorageMetricKey,
): number | undefined {
  const defined = points.filter((point) =>
    Number.isFinite(metricValue(point, metric)),
  );
  if (defined.length < 2) return undefined;
  const first = defined[0];
  const last = defined[defined.length - 1];
  const firstValue = metricValue(first, metric);
  const lastValue = metricValue(last, metric);
  if (firstValue == null || lastValue == null) return undefined;
  const firstAt = Date.parse(first.collected_at);
  const lastAt = Date.parse(last.collected_at);
  if (
    !Number.isFinite(firstAt) ||
    !Number.isFinite(lastAt) ||
    lastAt <= firstAt
  )
    return undefined;
  const hours = (lastAt - firstAt) / (60 * 60 * 1000);
  if (!(hours > 0)) return undefined;
  return (lastValue - firstValue) / hours;
}

function normalizeBreakdown(
  bucket: ProjectStorageVisibleSummary,
  breakdown?: ProjectStorageBreakdown | null,
  error?: unknown,
): StorageBucketBreakdownResult {
  const bytes = bucket.summaryBytes ?? breakdown?.bytes ?? 0;
  if (!breakdown) {
    return {
      key: bucket.key,
      label: bucket.summaryLabel,
      path: bucket.path,
      bytes,
      error: error instanceof Error ? error.message : `${error ?? ""}`.trim(),
    };
  }
  const children = [...(breakdown.children ?? [])]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6)
    .map((child) => ({
      path: child.path,
      absolute_path: posix.join(bucket.path, child.path),
      bytes: child.bytes,
      percent:
        breakdown.bytes > 0
          ? Math.max(0, Math.min(100, (100 * child.bytes) / breakdown.bytes))
          : 0,
    }));
  return {
    key: bucket.key,
    label: bucket.summaryLabel,
    path: bucket.path,
    bytes,
    collected_at: breakdown.collected_at,
    children,
  };
}

function findLargeCachePaths(
  bucket: StorageBucketBreakdownResult,
): StorageRecommendationAction[] {
  const cacheHints = new Set([
    ".cache",
    ".npm",
    ".pnpm-store",
    ".yarn",
    "node_modules",
    ".cargo",
    ".rustup",
    ".pytest_cache",
    ".mypy_cache",
  ]);
  return (bucket.children ?? [])
    .filter((child) => {
      const last = child.path.split("/").filter(Boolean).at(-1) ?? child.path;
      return cacheHints.has(last);
    })
    .slice(0, 3)
    .map((child) => ({
      type: "inspect_path" as const,
      path: child.absolute_path,
      reason: `Large cache-like directory in ${bucket.label}`,
    }));
}

function buildStorageAnalysis({
  project_id,
  title,
  homePath,
  overview,
  history,
  breakdowns,
}: {
  project_id: string;
  title: string;
  homePath: string;
  overview: ProjectStorageOverview;
  history: ProjectStorageHistory;
  breakdowns: StorageBucketBreakdownResult[];
}): StorageAnalysisResult {
  const quota = quotaSummary(overview);
  const home = visibleSummary(overview, "home");
  const scratch = visibleSummary(overview, "scratch");
  const environment = visibleSummary(overview, "environment");
  const snapshots = countedSummary(overview, "snapshots");
  const findings: StorageFinding[] = [];
  const recommendations: StorageRecommendation[] = [];
  const quotaPercent =
    quota && quota.size > 0 ? (100 * quota.used) / quota.size : undefined;
  const snapshotPath = posix.join(homePath, ".snapshots");

  if (quota?.warning) {
    findings.push({
      id: "quota_warning",
      severity: "warning",
      message: quota.warning,
    });
  }
  if (
    quota &&
    Number.isFinite(quotaPercent) &&
    quotaPercent != null &&
    quotaPercent >= 100
  ) {
    findings.push({
      id: "over_quota",
      severity: "error",
      message: `Project quota is exceeded by ${formatBytes(quota.used - quota.size)}.`,
    });
  } else if (
    quota &&
    Number.isFinite(quotaPercent) &&
    quotaPercent != null &&
    quotaPercent >= 90
  ) {
    findings.push({
      id: "quota_near_limit",
      severity: "warning",
      message: `Project quota is ${formatPercent(quotaPercent)} used.`,
    });
  }
  if ((snapshots?.bytes ?? 0) > 0) {
    findings.push({
      id: "snapshots_present",
      severity:
        quota && snapshots && snapshots.bytes > quota.size * 0.25
          ? "warning"
          : "info",
      message: `Snapshots are using ${formatBytes(snapshots?.bytes)} of counted storage.`,
    });
    recommendations.push({
      id: "delete_snapshots",
      priority: 100,
      message:
        "Delete unneeded snapshot folders under ~/.snapshots to free counted snapshot storage.",
      actions: [
        {
          type: "open_path",
          path: snapshotPath,
          reason: "Browse snapshots and delete old snapshot directories.",
        },
        {
          type: "run_command",
          command: `cocalc project file list --project ${quoteCliArg(project_id)} ${quoteCliArg(snapshotPath)}`,
          reason: "List snapshot directories from the CLI.",
        },
      ],
    });
  }
  if (
    environment &&
    environment.summaryBytes >
      Math.max(512 * 1024 * 1024, (home?.summaryBytes ?? 0) * 1.5)
  ) {
    findings.push({
      id: "environment_dominates_home",
      severity: "info",
      message: `Environment changes use ${formatBytes(environment.summaryBytes)}, which is larger than Home (${formatBytes(home?.summaryBytes)}).`,
    });
    recommendations.push({
      id: "review_environment",
      priority: 80,
      message:
        "Review environment changes first; large writable rootfs overlays often come from installed packages or system modifications.",
      actions: [
        {
          type: "inspect_path",
          path: environment.path,
          reason: "Inspect the writable overlay backing environment changes.",
          caution:
            "Do not delete overlay internals blindly; removing the wrong files can break the environment.",
        },
        {
          type: "run_command",
          command: `cocalc project storage breakdown --project ${quoteCliArg(project_id)} --path ${quoteCliArg(environment.path)}`,
          reason: "See which environment subtrees are largest.",
        },
      ],
    });
  }
  if ((scratch?.summaryBytes ?? 0) >= 5 * 1024 * 1024 * 1024) {
    findings.push({
      id: "scratch_large",
      severity: "info",
      message: `Scratch is using ${formatBytes(scratch?.summaryBytes)}.`,
    });
  }

  const breakdownErrors = breakdowns.filter((bucket) => bucket.error);
  for (const bucket of breakdownErrors) {
    findings.push({
      id: `scan_incomplete_${bucket.key}`,
      severity: "warning",
      message: `${bucket.label} could not be scanned quickly: ${bucket.error}`,
    });
    recommendations.push({
      id: `narrow_scan_${bucket.key}`,
      priority: 40,
      message: `Browse into a smaller ${bucket.label.toLowerCase()} folder before running another quick breakdown scan.`,
      actions: [
        {
          type: "run_command",
          command: `cocalc project storage breakdown --project ${quoteCliArg(project_id)} --path ${quoteCliArg(bucket.path)}`,
          reason: "Retry the quick scan on a narrower folder.",
        },
      ],
    });
  }

  for (const bucket of breakdowns) {
    const cacheActions = findLargeCachePaths(bucket);
    if (cacheActions.length > 0) {
      findings.push({
        id: `large_cache_${bucket.key}`,
        severity: "info",
        message: `Large cache-like directories were found in ${bucket.label}.`,
      });
      recommendations.push({
        id: `inspect_caches_${bucket.key}`,
        priority: 30,
        message: `Inspect large cache-like directories in ${bucket.label} before deleting source files or environments.`,
        actions: cacheActions,
      });
    }
  }

  const quotaSlope = history.growth?.quota_used_bytes_per_hour;
  if (quotaSlope != null && quotaSlope >= 512 * 1024 * 1024) {
    findings.push({
      id: "quota_growing_fast",
      severity: "warning",
      message: `Quota usage is growing at about ${formatRatePerHour(quotaSlope)}.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      id: "no_obvious_cleanup",
      priority: 0,
      message:
        "No obvious cleanup target stands out from the current storage summary. Inspect Home and Scratch breakdowns if you still need space.",
      actions: [
        {
          type: "run_command",
          command: `cocalc project storage breakdown --project ${quoteCliArg(project_id)} --path ${quoteCliArg(home?.path ?? homePath)}`,
          reason: "Inspect the current Home usage.",
        },
      ],
    });
  }

  recommendations.sort((a, b) => b.priority - a.priority);

  return {
    project_id,
    title,
    collected_at: overview.collected_at,
    home_path: homePath,
    summary: {
      quota: quota
        ? {
            label: quota.label,
            used_bytes: quota.used,
            size_bytes: quota.size,
            used_percent: quotaPercent,
            qgroupid: quota.qgroupid,
            scope: quota.scope,
            warning: quota.warning,
          }
        : null,
      visible: {
        home: home
          ? {
              label: home.summaryLabel,
              path: home.path,
              bytes: home.summaryBytes,
            }
          : null,
        scratch: scratch
          ? {
              label: scratch.summaryLabel,
              path: scratch.path,
              bytes: scratch.summaryBytes,
            }
          : null,
        environment: environment
          ? {
              label: environment.summaryLabel,
              path: environment.path,
              bytes: environment.summaryBytes,
            }
          : null,
      },
      counted: {
        snapshots: snapshots
          ? {
              label: snapshots.label,
              bytes: snapshots.bytes,
              detail: snapshots.detail,
            }
          : null,
      },
    },
    history: {
      window_minutes: history.window_minutes,
      point_count: history.point_count,
      latest_point: history.points.at(-1),
      growth: history.growth,
    },
    breakdowns,
    findings,
    recommendations,
  };
}

function renderStorageAnalysisHuman(analysis: StorageAnalysisResult): string {
  const lines: string[] = [];
  const quota = analysis.summary.quota;
  const visible = analysis.summary.visible;
  const snapshots = analysis.summary.counted.snapshots;
  lines.push(`Storage analysis for ${analysis.title}`);
  lines.push(`Project: ${analysis.project_id}`);
  lines.push(`Collected: ${analysis.collected_at}`);
  lines.push("");
  lines.push("Summary");
  if (quota) {
    lines.push(
      `- Quota: ${formatBytes(quota.used_bytes)} / ${formatBytes(quota.size_bytes)} (${formatPercent(quota.used_percent)})`,
    );
    if (quota.warning) {
      lines.push(`- Quota warning: ${quota.warning}`);
    }
  }
  if (visible.home) {
    lines.push(`- Home: ${formatBytes(visible.home.bytes)}`);
  }
  if (visible.scratch) {
    lines.push(`- Scratch: ${formatBytes(visible.scratch.bytes)}`);
  }
  if (visible.environment) {
    lines.push(`- Environment: ${formatBytes(visible.environment.bytes)}`);
  }
  if (snapshots) {
    lines.push(`- Snapshots: ${formatBytes(snapshots.bytes)}`);
  }
  if (analysis.history.growth?.quota_used_bytes_per_hour != null) {
    lines.push(
      `- Recent quota slope: ${formatRatePerHour(analysis.history.growth.quota_used_bytes_per_hour)}`,
    );
  }
  lines.push("");
  lines.push("Findings");
  for (const finding of analysis.findings) {
    lines.push(`- [${finding.severity}] ${finding.message}`);
  }
  lines.push("");
  lines.push("Recommendations");
  for (const recommendation of analysis.recommendations) {
    lines.push(`- ${recommendation.message}`);
    for (const action of recommendation.actions) {
      if (action.path) {
        lines.push(`  path: ${action.path}`);
      }
      if (action.command) {
        lines.push(`  command: ${action.command}`);
      }
      if (action.caution) {
        lines.push(`  caution: ${action.caution}`);
      }
    }
  }
  for (const bucket of analysis.breakdowns) {
    lines.push("");
    lines.push(`Largest ${bucket.label} paths`);
    if (bucket.error) {
      lines.push(`- ${bucket.error}`);
      continue;
    }
    for (const child of bucket.children ?? []) {
      lines.push(
        `- ${child.path}: ${formatBytes(child.bytes)} (${formatPercent(child.percent)})`,
      );
    }
  }
  return lines.join("\n");
}

function flattenStorageOverview({
  project_id,
  title,
  overview,
}: {
  project_id: string;
  title: string;
  overview: ProjectStorageOverview;
}): Record<string, unknown> {
  const quota = quotaSummary(overview);
  const home = visibleSummary(overview, "home");
  const scratch = visibleSummary(overview, "scratch");
  const environment = visibleSummary(overview, "environment");
  const snapshots = countedSummary(overview, "snapshots");
  return {
    project_id,
    title,
    collected_at: overview.collected_at,
    quota_used: formatBytes(quota?.used),
    quota_size: formatBytes(quota?.size),
    quota_percent:
      quota && quota.size > 0
        ? formatPercent((100 * quota.used) / quota.size)
        : "?",
    quota_warning: quota?.warning ?? "",
    home: formatBytes(home?.summaryBytes),
    scratch: formatBytes(scratch?.summaryBytes),
    environment: formatBytes(environment?.summaryBytes),
    snapshots: formatBytes(snapshots?.bytes ?? 0),
  };
}

function flattenStorageHistory(
  history: ProjectStorageHistory,
): Record<string, unknown>[] {
  return history.points.map((point) => ({
    collected_at: point.collected_at,
    quota: formatBytes(point.quota_used_bytes),
    quota_percent: formatPercent(point.quota_used_percent),
    home: formatBytes(point.home_visible_bytes),
    scratch: formatBytes(point.scratch_visible_bytes),
    environment: formatBytes(point.environment_visible_bytes),
    snapshots: formatBytes(point.snapshot_counted_bytes),
  }));
}

function flattenBreakdownRows(
  breakdown: ProjectStorageBreakdown,
): Record<string, unknown>[] {
  return [...(breakdown.children ?? [])]
    .sort((a, b) => b.bytes - a.bytes)
    .map((child) => ({
      path: posix.join(breakdown.path, child.path),
      bytes: formatBytes(child.bytes),
      percent:
        breakdown.bytes > 0
          ? formatPercent((100 * child.bytes) / breakdown.bytes)
          : "0%",
    }));
}

export function registerProjectStorageCommands(
  project: Command,
  deps: ProjectCommandDeps,
): void {
  const {
    withContext,
    resolveProjectConatClient,
    durationToMs,
    parsePositiveInteger,
  } = deps;

  const storage = project
    .command("storage")
    .description("project storage usage");

  storage
    .command("show")
    .description("show current project storage summary")
    .option("-w, --project <project>", "project id or name")
    .option("--home <path>", "home path override")
    .option(
      "--force-sample",
      "refresh overview and record a fresh history sample",
    )
    .action(
      async (
        opts: {
          project?: string;
          home?: string;
          forceSample?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project storage show", async (ctx) => {
          const { project: ws, client } = await resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const overview = await getStorageOverview({
            client,
            project_id: ws.project_id,
            home: opts.home,
            force_sample: !!opts.forceSample,
          });
          if (wantsJson(ctx)) {
            return {
              project_id: ws.project_id,
              title: ws.title,
              overview,
            };
          }
          return flattenStorageOverview({
            project_id: ws.project_id,
            title: ws.title,
            overview,
          });
        });
      },
    );

  storage
    .command("history")
    .description("show sampled project storage history")
    .option("-w, --project <project>", "project id or name")
    .option(
      "--window <duration>",
      "history window, e.g. 6h, 24h, 7d",
      DEFAULT_HISTORY_WINDOW,
    )
    .option("--points <n>", "max sampled points", `${DEFAULT_HISTORY_POINTS}`)
    .option("--force-sample", "record a fresh sample before loading history")
    .action(
      async (
        opts: {
          project?: string;
          window?: string;
          points?: string;
          forceSample?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project storage history", async (ctx) => {
          const { project: ws, client } = await resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const window_minutes = parseHistoryWindowMinutes(
            durationToMs,
            opts.window,
          );
          const max_points = parseMaxPoints(parsePositiveInteger, opts.points);
          if (opts.forceSample) {
            await getStorageOverview({
              client,
              project_id: ws.project_id,
              force_sample: true,
            });
          }
          const history = await getStorageHistory({
            client,
            project_id: ws.project_id,
            window_minutes,
            max_points,
          });
          if (wantsJson(ctx)) {
            return {
              project_id: ws.project_id,
              title: ws.title,
              history,
            };
          }
          return flattenStorageHistory(history);
        });
      },
    );

  storage
    .command("breakdown [path]")
    .description("show a quick one-level storage breakdown for a project path")
    .option("-w, --project <project>", "project id or name")
    .action(
      async (
        path: string | undefined,
        opts: { project?: string },
        command: Command,
      ) => {
        await withContext(command, "project storage breakdown", async (ctx) => {
          const { project: ws, client } = await resolveProjectConatClient(
            ctx,
            opts.project,
          );
          let targetPath = path;
          if (!targetPath) {
            const overview = await getStorageOverview({
              client,
              project_id: ws.project_id,
            });
            targetPath = visibleSummary(overview, "home")?.path ?? "/root";
          }
          const breakdown = await getStorageBreakdown({
            client,
            project_id: ws.project_id,
            path: targetPath,
          });
          if (wantsJson(ctx)) {
            return {
              project_id: ws.project_id,
              title: ws.title,
              breakdown,
            };
          }
          return flattenBreakdownRows(breakdown);
        });
      },
    );

  storage
    .command("analyze")
    .description("analyze project storage usage and suggest cleanup actions")
    .option("-w, --project <project>", "project id or name")
    .option("--home <path>", "home path override")
    .option(
      "--window <duration>",
      "history window, e.g. 6h, 24h, 7d",
      DEFAULT_HISTORY_WINDOW,
    )
    .option("--points <n>", "max sampled points", `${DEFAULT_HISTORY_POINTS}`)
    .option(
      "--force-sample",
      "refresh overview and record a fresh history sample",
    )
    .action(
      async (
        opts: {
          project?: string;
          home?: string;
          window?: string;
          points?: string;
          forceSample?: boolean;
        },
        command: Command,
      ) => {
        await withContext(command, "project storage analyze", async (ctx) => {
          const { project: ws, client } = await resolveProjectConatClient(
            ctx,
            opts.project,
          );
          const window_minutes = parseHistoryWindowMinutes(
            durationToMs,
            opts.window,
          );
          const max_points = parseMaxPoints(parsePositiveInteger, opts.points);
          const overview = await getStorageOverview({
            client,
            project_id: ws.project_id,
            home: opts.home,
            force_sample: !!opts.forceSample,
          });
          const homePath =
            visibleSummary(overview, "home")?.path ?? opts.home ?? "/root";
          const history = await getStorageHistory({
            client,
            project_id: ws.project_id,
            window_minutes,
            max_points,
          });
          const breakdowns = await Promise.all(
            overview.visible.map(async (bucket) => {
              try {
                const breakdown = await getStorageBreakdown({
                  client,
                  project_id: ws.project_id,
                  path: bucket.path,
                });
                return normalizeBreakdown(bucket, breakdown);
              } catch (err) {
                return normalizeBreakdown(bucket, null, err);
              }
            }),
          );
          const analysis = buildStorageAnalysis({
            project_id: ws.project_id,
            title: ws.title,
            homePath,
            overview,
            history,
            breakdowns,
          });
          if (wantsJson(ctx)) {
            return analysis;
          }
          console.log(renderStorageAnalysisHuman(analysis));
          return null;
        });
      },
    );
}

export const testOnly = {
  buildStorageAnalysis,
  flattenStorageHistory,
  flattenBreakdownRows,
  parseHistoryWindowMinutes,
  computeMetricSlopePerHour,
};
