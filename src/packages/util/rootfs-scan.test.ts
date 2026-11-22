/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  DEFAULT_TRIVY_SCANNER_IMAGE,
  ROOTFS_SCAN_ALLOW_UNPINNED_IMAGE_ENV,
  allowUnpinnedScannerImage,
  assertPinnedScannerImage,
  evaluateRootfsScanSelection,
  parseTrivyRootfsJsonReport,
  rootfsScanHasBlockingFindings,
  scannerImageDigest,
} from "./rootfs-scan";
import { EXTRAS } from "./db-schema/site-settings-extras";

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

describe("scanner image pinning", () => {
  const digest = `sha256:${"a".repeat(64)}`;

  it("pins the default scanner image by digest", () => {
    expect(scannerImageDigest(DEFAULT_TRIVY_SCANNER_IMAGE)).toBe(
      "sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c",
    );
  });

  it("reads the digest of a pinned reference only", () => {
    expect(scannerImageDigest(`docker.io/aquasec/trivy:0.76.1@${digest}`)).toBe(
      digest,
    );
    expect(scannerImageDigest(`registry.example/trivy@${digest}`)).toBe(digest);
    for (const ref of [
      "docker.io/aquasec/trivy:latest",
      "docker.io/aquasec/trivy",
      "trivy@sha256:short",
      `trivy@sha256:${"A".repeat(64)}`,
      `trivy@sha512:${"a".repeat(64)}`,
      "",
    ]) {
      expect(scannerImageDigest(ref)).toBeUndefined();
    }
  });

  it("fails closed on a tag-only image unless the development escape is set", () => {
    expect(() =>
      assertPinnedScannerImage("docker.io/aquasec/trivy:latest", {
        allowUnpinned: false,
      }),
    ).toThrow("not pinned by digest");
    expect(() => assertPinnedScannerImage("", { allowUnpinned: true })).toThrow(
      "must be specified",
    );
    expect(
      assertPinnedScannerImage(` registry.example/trivy@${digest} `, {
        allowUnpinned: false,
      }),
    ).toBe(`registry.example/trivy@${digest}`);
    expect(
      assertPinnedScannerImage("localhost/trivy:dev", { allowUnpinned: true }),
    ).toBe("localhost/trivy:dev");
  });

  it("only takes the escape when it is set to exactly 1", () => {
    expect(allowUnpinnedScannerImage({})).toBe(false);
    expect(
      allowUnpinnedScannerImage({
        [ROOTFS_SCAN_ALLOW_UNPINNED_IMAGE_ENV]: "true",
      }),
    ).toBe(false);
    expect(
      allowUnpinnedScannerImage({
        [ROOTFS_SCAN_ALLOW_UNPINNED_IMAGE_ENV]: "1",
      }),
    ).toBe(true);
  });

  it("accepts only a blank or digest-pinned site setting", () => {
    const valid = EXTRAS.rootfs_scan_container_image.valid as (
      value: string,
    ) => boolean;
    expect(valid("")).toBe(true);
    expect(valid(`registry.example/trivy@${digest}`)).toBe(true);
    expect(valid("docker.io/aquasec/trivy:latest")).toBe(false);
  });
});
