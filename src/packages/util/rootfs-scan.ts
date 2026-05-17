/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  RootfsScanAdminNote,
  RootfsScanFinding,
  RootfsScanSeverity,
  RootfsScanStatus,
  RootfsScanSummary,
} from "./rootfs-images";

export const ROOTFS_SCAN_SEVERITIES: RootfsScanSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];

const SEVERITY_RANK: Record<RootfsScanSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  unknown: 1,
};

export type TrivyRootfsScanTarget = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  arch?: string;
  size_bytes?: number;
};

export type TrivyScanMetadata = {
  tool_version?: string;
  db?: RootfsScanSummary["db"];
  started_at?: string;
  scanned_at?: string;
  duration_ms?: number;
  report?: RootfsScanSummary["report"];
};

export type TrivyVulnerability = {
  VulnerabilityID?: unknown;
  PkgName?: unknown;
  InstalledVersion?: unknown;
  FixedVersion?: unknown;
  Severity?: unknown;
  Title?: unknown;
  PrimaryURL?: unknown;
};

export type TrivyResult = {
  Target?: unknown;
  Type?: unknown;
  Vulnerabilities?: TrivyVulnerability[] | null;
};

export type TrivyJsonReport = {
  Results?: TrivyResult[] | null;
};

export type RootfsScanSelectionPolicy = {
  block_severity?: RootfsScanSeverity;
  unscanned_official_policy?: "warn" | "block";
  now?: Date;
};

export type RootfsScanSelectionDecision = {
  allowed: boolean;
  reason: "allowed" | "unscanned" | "scan_pending" | "scan_error" | "findings";
  blocking_severity?: RootfsScanSeverity;
  message?: string;
};

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeRootfsScanSeverity(
  severity: unknown,
): RootfsScanSeverity {
  switch (`${severity ?? ""}`.trim().toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "unknown";
  }
}

export function emptyRootfsScanSeverityCounts(): Record<
  RootfsScanSeverity,
  number
> {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
}

function sortFindings(a: RootfsScanFinding, b: RootfsScanFinding): number {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  return a.id.localeCompare(b.id);
}

export function parseTrivyRootfsJsonReport({
  report,
  target,
  metadata = {},
  max_findings = 25,
}: {
  report: TrivyJsonReport;
  target: TrivyRootfsScanTarget;
  metadata?: TrivyScanMetadata;
  max_findings?: number;
}): RootfsScanSummary {
  const severity_counts = emptyRootfsScanSeverityCounts();
  const findings: RootfsScanFinding[] = [];
  const results = Array.isArray(report?.Results) ? report.Results : [];

  for (const result of results) {
    const vulnerabilities = Array.isArray(result?.Vulnerabilities)
      ? result.Vulnerabilities
      : [];
    for (const vulnerability of vulnerabilities) {
      const id = stringValue(vulnerability?.VulnerabilityID);
      if (!id) continue;
      const severity = normalizeRootfsScanSeverity(vulnerability?.Severity);
      severity_counts[severity] += 1;
      findings.push({
        id,
        severity,
        package_name: stringValue(vulnerability?.PkgName),
        installed_version: stringValue(vulnerability?.InstalledVersion),
        fixed_version: stringValue(vulnerability?.FixedVersion),
        title: stringValue(vulnerability?.Title),
        primary_url: stringValue(vulnerability?.PrimaryURL),
      });
    }
  }

  findings.sort(sortFindings);
  const totalFindings = ROOTFS_SCAN_SEVERITIES.reduce(
    (total, severity) => total + severity_counts[severity],
    0,
  );
  const status: RootfsScanStatus = totalFindings > 0 ? "findings" : "clean";

  return {
    status,
    policy_status: totalFindings > 0 ? "blocked" : "allowed",
    tool: "trivy",
    tool_version: metadata.tool_version,
    scanner_version: metadata.tool_version,
    started_at: metadata.started_at,
    scanned_at: metadata.scanned_at ?? new Date().toISOString(),
    duration_ms: metadata.duration_ms,
    db: metadata.db,
    target,
    severity_counts,
    findings_summary: severity_counts,
    highest_findings: findings.slice(0, Math.max(0, max_findings)),
    summary:
      totalFindings === 0
        ? "No vulnerabilities found"
        : `${totalFindings} vulnerabilities found`,
    report: metadata.report,
  };
}

function noteIsActive(note: RootfsScanAdminNote, now: Date): boolean {
  if (!note.expires_at) return true;
  const expires = Date.parse(note.expires_at);
  return Number.isFinite(expires) && expires > now.getTime();
}

function hasActiveException(summary: RootfsScanSummary, now: Date): boolean {
  return (summary.admin_notes ?? []).some((note) => {
    if (!noteIsActive(note, now)) return false;
    return note.kind === "accepted_risk" || note.kind === "false_positive";
  });
}

export function rootfsScanHasBlockingFindings({
  summary,
  block_severity = "critical",
  now = new Date(),
}: {
  summary?: RootfsScanSummary | null;
  block_severity?: RootfsScanSeverity;
  now?: Date;
}): RootfsScanSeverity | undefined {
  if (!summary || summary.policy_status === "admin_exception") return;
  if (hasActiveException(summary, now)) return;
  const threshold = SEVERITY_RANK[block_severity];
  const counts = summary.severity_counts ?? summary.findings_summary ?? {};
  for (const severity of ROOTFS_SCAN_SEVERITIES) {
    if (SEVERITY_RANK[severity] < threshold) continue;
    if (Number(counts[severity] ?? 0) > 0) {
      return severity;
    }
  }
}

export function evaluateRootfsScanSelection({
  summary,
  official,
  shared,
  policy = {},
}: {
  summary?: RootfsScanSummary | null;
  official?: boolean;
  shared?: boolean;
  policy?: RootfsScanSelectionPolicy;
}): RootfsScanSelectionDecision {
  if (!official && !shared) {
    return { allowed: true, reason: "allowed" };
  }
  const status = summary?.status ?? "unknown";
  if (status === "unknown") {
    const block = policy.unscanned_official_policy === "block";
    return {
      allowed: !block,
      reason: "unscanned",
      message: block
        ? "This RootFS image has not been vulnerability scanned yet."
        : undefined,
    };
  }
  if (status === "pending") {
    return { allowed: true, reason: "scan_pending" };
  }
  if (status === "error") {
    return { allowed: true, reason: "scan_error" };
  }
  const blocking_severity = rootfsScanHasBlockingFindings({
    summary,
    block_severity: policy.block_severity,
    now: policy.now,
  });
  if (blocking_severity) {
    return {
      allowed: false,
      reason: "findings",
      blocking_severity,
      message: `This RootFS image has unresolved ${blocking_severity} vulnerabilities.`,
    };
  }
  return { allowed: true, reason: "allowed" };
}
