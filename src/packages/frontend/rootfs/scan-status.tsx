/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Button,
  Descriptions,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { useState, type ReactNode } from "react";

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

function formatBytes(bytes?: number): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function scanSeverityRows(scan?: RootfsScanSummary) {
  return SEVERITIES.map((severity) => ({
    severity,
    count: scan?.severity_counts?.[severity] ?? 0,
  })).filter((row) => row.count > 0);
}

function RootfsScanDetails({ scan }: { scan: RootfsScanSummary }) {
  const findings = scan.highest_findings ?? [];
  const target = scan.target;
  const report = scan.report;
  const severityRows = scanSeverityRows(scan);
  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Descriptions size="small" bordered column={1}>
        <Descriptions.Item label="Status">
          <Space wrap size="small">
            <Tag>{scan.status ?? "unknown"}</Tag>
            {scan.policy_status ? <Tag>{scan.policy_status}</Tag> : null}
          </Space>
        </Descriptions.Item>
        {scan.summary ? (
          <Descriptions.Item label="Summary">{scan.summary}</Descriptions.Item>
        ) : null}
        <Descriptions.Item label="Scanner">
          {[scan.tool, scan.tool_version, scan.scanner_version]
            .filter(Boolean)
            .join(" ") || "unknown"}
        </Descriptions.Item>
        {scan.scanned_at || scan.started_at || scan.duration_ms ? (
          <Descriptions.Item label="Timing">
            {scan.started_at ? `started ${scan.started_at}` : ""}
            {scan.scanned_at ? ` scanned ${scan.scanned_at}` : ""}
            {scan.duration_ms
              ? ` duration ${Math.round(scan.duration_ms / 1000)}s`
              : ""}
          </Descriptions.Item>
        ) : null}
        {target ? (
          <Descriptions.Item label="Target">
            <Space orientation="vertical" size={0}>
              {target.project_id ? (
                <span>
                  Project: <code>{target.project_id}</code>
                </span>
              ) : null}
              {target.release_id ? (
                <span>
                  Release: <code>{target.release_id}</code>
                </span>
              ) : null}
              {target.runtime_image ? (
                <span>
                  Image: <code>{target.runtime_image}</code>
                </span>
              ) : null}
              {target.content_key ? (
                <span>
                  Content key: <code>{target.content_key}</code>
                </span>
              ) : null}
              {target.arch || target.size_bytes ? (
                <span>
                  {[target.arch, formatBytes(target.size_bytes)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </Space>
          </Descriptions.Item>
        ) : null}
        {scan.db?.updated_at || scan.db?.version || scan.db?.source ? (
          <Descriptions.Item label="Vulnerability DB">
            {[scan.db.version, scan.db.updated_at, scan.db.source]
              .filter(Boolean)
              .join(" · ")}
          </Descriptions.Item>
        ) : null}
        {report ? (
          <Descriptions.Item label="Retained report">
            <Space orientation="vertical" size={0}>
              {report.artifact_id ? (
                <span>
                  Report id: <code>{report.artifact_id}</code>
                </span>
              ) : null}
              {report.format ? <span>Format: {report.format}</span> : null}
              {report.sha256 ? (
                <span>
                  SHA-256: <code>{report.sha256}</code>
                </span>
              ) : null}
              {report.bytes || report.compressed_bytes ? (
                <span>
                  {[
                    formatBytes(report.bytes),
                    report.compressed_bytes
                      ? `${formatBytes(report.compressed_bytes)} compressed`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
              {report.retention_until ? (
                <span>Retained until: {report.retention_until}</span>
              ) : null}
            </Space>
          </Descriptions.Item>
        ) : null}
        {scan.error?.message ? (
          <Descriptions.Item label="Error">
            <Typography.Text type="danger">
              {scan.error.message}
            </Typography.Text>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      {severityRows.length > 0 ? (
        <Table
          size="small"
          pagination={false}
          rowKey="severity"
          dataSource={severityRows}
          columns={[
            { title: "Severity", dataIndex: "severity", key: "severity" },
            { title: "Count", dataIndex: "count", key: "count" },
          ]}
        />
      ) : null}
      {findings.length > 0 ? (
        <Table<RootfsScanFinding>
          size="small"
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          rowKey={(finding, index) =>
            `${finding.id}-${finding.package_name ?? ""}-${index}`
          }
          dataSource={findings}
          columns={[
            { title: "ID", dataIndex: "id", key: "id" },
            { title: "Severity", dataIndex: "severity", key: "severity" },
            { title: "Package", dataIndex: "package_name", key: "package" },
            {
              title: "Installed",
              dataIndex: "installed_version",
              key: "installed",
            },
            { title: "Fixed", dataIndex: "fixed_version", key: "fixed" },
            {
              title: "Details",
              key: "details",
              render: (_, finding) =>
                finding.primary_url ? (
                  <Typography.Link
                    href={finding.primary_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {finding.title ?? finding.primary_url}
                  </Typography.Link>
                ) : (
                  finding.title
                ),
            },
          ]}
        />
      ) : null}
    </Space>
  );
}

export function RootfsScanDetailsButton({
  scan,
  title = "RootFS scan details",
  onDownloadReport,
}: {
  scan?: RootfsScanSummary;
  title?: string;
  onDownloadReport?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!scan?.status || scan.status === "unknown") return null;
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        Details
      </Button>
      <Modal
        open={open}
        title={title}
        width={900}
        footer={
          <Space>
            {scan.report?.artifact_id && onDownloadReport ? (
              <Button onClick={onDownloadReport}>Download full JSON</Button>
            ) : null}
            <Button type="primary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </Space>
        }
        onCancel={() => setOpen(false)}
      >
        <RootfsScanDetails scan={scan} />
      </Modal>
    </>
  );
}

export function RootfsScanStatus({
  entry,
  showUnknown = true,
  maxFindings = 3,
  showDetails = true,
  detailsTitle,
  onDownloadReport,
}: {
  entry: Pick<RootfsImageEntry, "scan" | "official">;
  showUnknown?: boolean;
  maxFindings?: number;
  showDetails?: boolean;
  detailsTitle?: string;
  onDownloadReport?: () => void;
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
        {showDetails ? (
          <RootfsScanDetailsButton
            scan={scan}
            title={detailsTitle}
            onDownloadReport={onDownloadReport}
          />
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
