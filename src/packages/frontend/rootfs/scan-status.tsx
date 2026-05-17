/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space, Tag, Typography } from "antd";
import type { ReactNode } from "react";

import { Tooltip } from "@cocalc/frontend/components";
import type {
  RootfsImageEntry,
  RootfsScanFinding,
  RootfsScanSeverity,
  RootfsScanSummary,
} from "@cocalc/util/rootfs-images";

const SEVERITIES: RootfsScanSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
];

function severityTotal(scan?: RootfsScanSummary): number {
  return SEVERITIES.reduce(
    (total, severity) => total + (scan?.severity_counts?.[severity] ?? 0),
    0,
  );
}

function highestSeverity(scan?: RootfsScanSummary): RootfsScanSeverity | null {
  for (const severity of SEVERITIES) {
    if ((scan?.severity_counts?.[severity] ?? 0) > 0) {
      return severity;
    }
  }
  return null;
}

export function rootfsScanStatusLabel(entry: {
  scan?: RootfsScanSummary;
  official?: boolean;
}): string {
  const scan = entry.scan;
  if (!scan?.status || scan.status === "unknown") {
    return entry.official ? "Unscanned" : "Scan unknown";
  }
  if (scan.status === "clean") return "Scanned clean";
  if (scan.status === "pending") return "Scan pending";
  if (scan.status === "error") return "Scan failed";
  const severity = highestSeverity(scan);
  if (severity === "critical") return "Critical findings";
  if (severity === "high") return "High findings";
  return "Findings";
}

export function rootfsScanStatusColor(entry: {
  scan?: RootfsScanSummary;
  official?: boolean;
}): string | undefined {
  const scan = entry.scan;
  if (!scan?.status || scan.status === "unknown") {
    return entry.official ? "default" : undefined;
  }
  if (scan.status === "clean") return "green";
  if (scan.status === "pending") return "blue";
  if (scan.status === "error") return "red";
  if (highestSeverity(scan) === "critical") return "red";
  return "orange";
}

function severityCounts(scan?: RootfsScanSummary): string | undefined {
  const counts = scan?.severity_counts;
  if (!counts || severityTotal(scan) === 0) return;
  return SEVERITIES.map((severity) => `${severity}=${counts[severity] ?? 0}`)
    .filter((part) => !part.endsWith("=0"))
    .join(" ");
}

function scanTooltip(entry: {
  scan?: RootfsScanSummary;
  official?: boolean;
}): ReactNode {
  const scan = entry.scan;
  if (!scan?.status || scan.status === "unknown") {
    return entry.official
      ? "This official image has not been vulnerability-scanned yet."
      : "No scan result is available for this image.";
  }
  const details = [
    scan.tool ? `scanner: ${scan.tool}` : undefined,
    scan.tool_version ? `version: ${scan.tool_version}` : undefined,
    scan.db?.updated_at ? `database: ${scan.db.updated_at}` : undefined,
    scan.scanned_at ? `scanned: ${scan.scanned_at}` : undefined,
    severityCounts(scan),
  ].filter(Boolean);
  return details.length > 0 ? details.join("\n") : rootfsScanStatusLabel(entry);
}

export function RootfsScanStatusTag({
  entry,
  showUnknown = false,
}: {
  entry: Pick<RootfsImageEntry, "scan" | "official">;
  showUnknown?: boolean;
}) {
  const color = rootfsScanStatusColor(entry);
  if (!color && !showUnknown) return null;
  return (
    <Tooltip
      title={
        <span style={{ whiteSpace: "pre-line" }}>{scanTooltip(entry)}</span>
      }
    >
      <Tag color={color} style={{ marginInlineEnd: 0 }}>
        {rootfsScanStatusLabel(entry)}
      </Tag>
    </Tooltip>
  );
}

function FindingRow({ finding }: { finding: RootfsScanFinding }) {
  const title = finding.title ? ` - ${finding.title}` : "";
  const version =
    finding.installed_version || finding.fixed_version
      ? ` ${finding.installed_version ?? "?"} -> ${finding.fixed_version ?? "no fix listed"}`
      : "";
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {finding.id} {finding.severity}{" "}
      {finding.package_name ?? "unknown package"}
      {version}
      {title}
    </Typography.Text>
  );
}

export function RootfsScanStatus({
  entry,
  showUnknown = true,
  maxFindings = 3,
}: {
  entry: Pick<RootfsImageEntry, "scan" | "official">;
  showUnknown?: boolean;
  maxFindings?: number;
}) {
  const scan = entry.scan;
  if ((!scan?.status || scan.status === "unknown") && !showUnknown) {
    return null;
  }
  const counts = severityCounts(scan);
  const findings = scan?.highest_findings?.slice(0, maxFindings) ?? [];
  return (
    <Space orientation="vertical" size={2} style={{ width: "100%" }}>
      <Space wrap size={[4, 4]}>
        <RootfsScanStatusTag entry={entry} showUnknown={showUnknown} />
        {scan?.tool ? (
          <Tag style={{ marginInlineEnd: 0 }}>{scan.tool}</Tag>
        ) : null}
        {scan?.scanned_at ? (
          <Tag style={{ marginInlineEnd: 0 }}>scanned {scan.scanned_at}</Tag>
        ) : null}
      </Space>
      {counts ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {counts}
        </Typography.Text>
      ) : null}
      {scan?.summary ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {scan.summary}
        </Typography.Text>
      ) : null}
      {scan?.error?.message ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          {scan.error.message}
        </Typography.Text>
      ) : null}
      {findings.length > 0 ? (
        <Space orientation="vertical" size={0}>
          {findings.map((finding) => (
            <FindingRow
              key={`${finding.id}-${finding.package_name}`}
              finding={finding}
            />
          ))}
        </Space>
      ) : null}
    </Space>
  );
}
