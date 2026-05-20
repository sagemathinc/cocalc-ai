/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  evaluateRootfsScanSelection,
  parseTrivyRootfsJsonReport,
  rootfsScanHasBlockingFindings,
} from "./rootfs-scan";

const target = {
  release_id: "rel-1",
  content_key: "content-1",
  runtime_image: "cocalc.local/rootfs/content-1",
};

describe("parseTrivyRootfsJsonReport", () => {
  it("summarizes a clean Trivy report", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: { Results: [{ Target: "rootfs", Vulnerabilities: [] }] },
      target,
      metadata: {
        tool_version: "0.59.1",
        db: { updated_at: "2026-05-17T00:00:00.000Z" },
        scanned_at: "2026-05-17T01:00:00.000Z",
      },
    });

    expect(summary.status).toBe("clean");
    expect(summary.policy_status).toBe("allowed");
    expect(summary.tool).toBe("trivy");
    expect(summary.tool_version).toBe("0.59.1");
    expect(summary.severity_counts).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    });
    expect(summary.highest_findings).toEqual([]);
  });

  it("summarizes and sorts vulnerabilities by severity", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: {
        Results: [
          {
            Target: "rootfs",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-low",
                PkgName: "pkg-low",
                InstalledVersion: "1.0",
                FixedVersion: "1.1",
                Severity: "LOW",
                Title: "low issue",
                PrimaryURL: "https://example.com/low",
              },
              {
                VulnerabilityID: "CVE-critical",
                PkgName: "pkg-critical",
                Severity: "CRITICAL",
              },
              {
                VulnerabilityID: "CVE-high",
                Severity: "HIGH",
              },
            ],
          },
        ],
      },
      target,
      max_findings: 2,
    });

    expect(summary.status).toBe("findings");
    expect(summary.policy_status).toBe("blocked");
    expect(summary.severity_counts).toEqual({
      critical: 1,
      high: 1,
      medium: 0,
      low: 1,
      unknown: 0,
    });
    expect(summary.highest_findings?.map((finding) => finding.id)).toEqual([
      "CVE-critical",
      "CVE-high",
    ]);
  });

  it("normalizes unknown severities", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: {
        Results: [
          {
            Vulnerabilities: [
              { VulnerabilityID: "CVE-unknown", Severity: "WEIRD" },
            ],
          },
        ],
      },
      target,
    });

    expect(summary.severity_counts?.unknown).toBe(1);
  });
});

describe("rootfs scan selection policy", () => {
  it("warns but allows official images with critical findings", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: {
        Results: [
          {
            Vulnerabilities: [
              { VulnerabilityID: "CVE-critical", Severity: "CRITICAL" },
            ],
          },
        ],
      },
      target,
    });

    expect(rootfsScanHasBlockingFindings({ summary })).toBe("critical");
    expect(evaluateRootfsScanSelection({ summary, official: true })).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: "findings",
        blocking_severity: "critical",
      }),
    );
  });

  it("does not block private non-shared images in the first policy", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: {
        Results: [
          {
            Vulnerabilities: [
              { VulnerabilityID: "CVE-critical", Severity: "CRITICAL" },
            ],
          },
        ],
      },
      target,
    });

    expect(evaluateRootfsScanSelection({ summary })).toEqual({
      allowed: true,
      reason: "allowed",
    });
  });

  it("warns but allows unscanned official images by default", () => {
    expect(evaluateRootfsScanSelection({ official: true })).toEqual({
      allowed: true,
      reason: "unscanned",
      message: undefined,
    });
  });

  it("can block unscanned official images when policy is strict", () => {
    expect(
      evaluateRootfsScanSelection({
        official: true,
        policy: { unscanned_official_policy: "block" },
      }),
    ).toEqual({
      allowed: false,
      reason: "unscanned",
      message: "This RootFS image has not been vulnerability scanned yet.",
    });
  });

  it("allows active accepted-risk exceptions", () => {
    const summary = parseTrivyRootfsJsonReport({
      report: {
        Results: [
          {
            Vulnerabilities: [
              { VulnerabilityID: "CVE-critical", Severity: "CRITICAL" },
            ],
          },
        ],
      },
      target,
    });
    summary.admin_notes = [
      {
        kind: "accepted_risk",
        note: "temporary exception",
        expires_at: "2026-06-01T00:00:00.000Z",
      },
    ];

    expect(
      evaluateRootfsScanSelection({
        summary,
        official: true,
        policy: { now: new Date("2026-05-17T00:00:00.000Z") },
      }),
    ).toEqual({ allowed: true, reason: "allowed" });
  });
});
