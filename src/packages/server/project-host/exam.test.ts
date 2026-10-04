/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/backend/data", () => ({
  conatPassword: "exam-test-secret",
}));

import { __test__ } from "./exam";

describe("project-host exam configuration", () => {
  it("derives the exam hostname from the stable project-host hostname", () => {
    expect(
      __test__.examHostnameForHost({
        id: "00000000-1000-4000-8000-000000000001",
        public_url:
          "https://host-00000000-1000-4000-8000-000000000001-staging.cocalc.ai",
      }),
    ).toBe("exam-00000000-1000-4000-8000-000000000001-staging.cocalc.ai");
  });

  it("names the exam hostname after the host id without a host- label", () => {
    // The project host derives the same name (project-host/conat-router.ts).
    expect(
      __test__.examHostnameForHost({
        id: "00000000-1000-4000-8000-000000000123",
        public_url: "https://compute.example.com",
      }),
    ).toBe("exam-00000000-1000-4000-8000-000000000123.example.com");
  });

  it("uses an already cached exam RootFS without pulling it again", async () => {
    const pullRootfsImage = jest.fn();
    const loadVisibleRootfsImages = jest.fn();
    await expect(
      __test__.ensureExamRootfsCached({
        control: {
          listRootfsImages: async () => [
            { image: "cocalc.local/rootfs/sage", digest: "sha256:cached" },
          ],
          pullRootfsImage,
        },
        rootfs_image: "cocalc.local/rootfs/sage",
        actor_account_id: "account-1",
        loadVisibleRootfsImages,
      }),
    ).resolves.toEqual({
      image: "cocalc.local/rootfs/sage",
      digest: "sha256:cached",
    });
    expect(loadVisibleRootfsImages).not.toHaveBeenCalled();
    expect(pullRootfsImage).not.toHaveBeenCalled();
  });

  it("pulls and pins a visible catalog RootFS during preparation", async () => {
    const pullRootfsImage = jest.fn(async ({ image }) => ({
      image,
      digest: "sha256:pinned",
    }));
    await expect(
      __test__.ensureExamRootfsCached({
        control: {
          listRootfsImages: async () => [],
          pullRootfsImage,
        },
        rootfs_image: "cocalc.local/rootfs/sage",
        actor_account_id: "account-1",
        loadVisibleRootfsImages: async () => ({
          version: 1,
          images: [
            {
              id: "sage",
              image: "cocalc.local/rootfs/sage",
              label: "SageMath",
            },
          ],
        }),
      }),
    ).resolves.toEqual({
      image: "cocalc.local/rootfs/sage",
      digest: "sha256:pinned",
    });
    expect(pullRootfsImage).toHaveBeenCalledWith({
      image: "cocalc.local/rootfs/sage",
    });
  });

  it("does not pull an uncached RootFS outside the visible catalog", async () => {
    const pullRootfsImage = jest.fn();
    await expect(
      __test__.ensureExamRootfsCached({
        control: {
          listRootfsImages: async () => [],
          pullRootfsImage,
        },
        rootfs_image: "registry.invalid/private",
        actor_account_id: "account-1",
        loadVisibleRootfsImages: async () => ({ version: 1, images: [] }),
      }),
    ).rejects.toThrow("not available in your managed image catalog");
    expect(pullRootfsImage).not.toHaveBeenCalled();
  });

  it("requires the host runtime before destructive exam cleanup", () => {
    expect(() =>
      __test__.assertExamHostRunningForCleanup({
        id: "00000000-1000-4000-8000-000000000001",
        status: "deprovisioned",
      }),
    ).toThrow(
      "start the host and end the exam before stopping or deprovisioning it",
    );
    expect(() =>
      __test__.assertExamHostRunningForCleanup({
        id: "00000000-1000-4000-8000-000000000001",
        status: "running",
      }),
    ).not.toThrow();
  });

  it("requires a reconciled public IPv4 address for exam DNS", () => {
    expect(
      __test__.publicIp({
        id: "00000000-1000-4000-8000-000000000001",
        public_ip: "34.0.129.201",
      }),
    ).toBe("34.0.129.201");
    expect(
      __test__.publicIp({
        id: "00000000-1000-4000-8000-000000000001",
        metadata: { runtime: { public_ip: "34.0.129.202" } },
      }),
    ).toBe("34.0.129.202");
    expect(() =>
      __test__.publicIp({
        id: "00000000-1000-4000-8000-000000000001",
        public_ip: null,
      }),
    ).toThrow("reconciled public IPv4");
  });

  it("follows the host's active public route transport", () => {
    expect(
      __test__.examDnsRoute({
        id: "00000000-1000-4000-8000-000000000001",
        metadata: {
          public_route: { active_mode: "cloudflare-proxy" },
          runtime: { public_ip: "34.0.129.201" },
        },
      }),
    ).toEqual({ type: "A", target: "34.0.129.201" });
    expect(
      __test__.examDnsRoute({
        id: "00000000-1000-4000-8000-000000000001",
        metadata: {
          cloudflare_tunnel: {
            id: "00000000-2000-4000-8000-000000000002",
          },
        },
      }),
    ).toEqual({
      type: "CNAME",
      target: "00000000-2000-4000-8000-000000000002.cfargotunnel.com",
    });
    expect(() =>
      __test__.examDnsRoute({
        id: "00000000-1000-4000-8000-000000000001",
      }),
    ).toThrow("active direct route or Cloudflare tunnel");
  });

  it("repairs direct HTTPS ingress while reconciling exam DNS", async () => {
    const host = {
      id: "00000000-1000-4000-8000-000000000001",
      metadata: {
        public_route: { active_mode: "cloudflare-proxy" },
        runtime: { public_ip: "34.0.129.201" },
      },
    };
    const ensureDirectIngress = jest.fn(async () => {});
    await __test__.ensureExamPublicIngress({
      host,
      route: __test__.examDnsRoute(host),
      ensureDirectIngress,
    });
    expect(ensureDirectIngress).toHaveBeenCalledWith(host);
  });

  it("does not add direct ingress to tunnel-routed exam hosts", async () => {
    const host = {
      id: "00000000-1000-4000-8000-000000000001",
      metadata: {
        cloudflare_tunnel: {
          id: "00000000-2000-4000-8000-000000000002",
        },
      },
    };
    const ensureDirectIngress = jest.fn(async () => {});
    await __test__.ensureExamPublicIngress({
      host,
      route: __test__.examDnsRoute(host),
      ensureDirectIngress,
    });
    expect(ensureDirectIngress).not.toHaveBeenCalled();
  });

  it("keeps terminal access disabled unless explicitly enabled", () => {
    const base = {
      enabled: true,
      max_projects: 100,
      project_cpu: 1,
      project_memory_mb: 2_000,
      project_disk_mb: 5_000,
      project_ttl_minutes: 360,
      cleanup_grace_minutes: 10,
      network_mode: "disabled" as const,
    };
    expect(__test__.normalizeConfig(base).terminal_enabled).toBe(false);
    expect(
      __test__.normalizeConfig({ ...base, terminal_enabled: true })
        .terminal_enabled,
    ).toBe(true);
  });

  it("normalizes the public scratchpad title", () => {
    expect(
      __test__.normalizeConfig({
        ...__test__.DEFAULT_EXAM_CONFIG,
        title: "  Linear Algebra Scratchpad  ",
      }).title,
    ).toBe("Linear Algebra Scratchpad");
    expect(() =>
      __test__.normalizeConfig({
        ...__test__.DEFAULT_EXAM_CONFIG,
        title: "x".repeat(101),
      }),
    ).toThrow("1 to 100 characters");
  });

  it("rejects unsupported exam network modes", () => {
    expect(() =>
      __test__.normalizeConfig({
        ...__test__.DEFAULT_EXAM_CONFIG,
        enabled: true,
        network_mode: "enabled" as any,
      }),
    ).toThrow("supports only disabled");
  });

  it("stores a memory-hard token hash rather than the plaintext token", () => {
    const encoded = __test__.hashToken("do-not-store-this-token");
    expect(encoded).toMatch(/^scrypt-v1\$[^$]+\$[^$]+$/);
    expect(encoded).not.toContain("do-not-store-this-token");
  });

  it("accepts an instructor-selected stable admission token", () => {
    expect(__test__.normalizeAdmissionToken("  UCL-practice-2026  ")).toBe(
      "UCL-practice-2026",
    );
    expect(() => __test__.normalizeAdmissionToken("short")).toThrow("8 to 200");
  });

  it("recovers the current instructor token without storing plaintext", () => {
    const row = {
      run_id: "00000000-2000-4000-8000-000000000002",
      status: "ready",
      token_idempotency_key: "rotate:stable-key",
    };
    const first = __test__.tokenForRunRecord(row);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(__test__.tokenForRunRecord(row)).toBe(first);
    expect(
      __test__.tokenForRunRecord({ ...row, status: "stopped" }),
    ).toBeUndefined();
  });

  it("reconciles central lifecycle state from the authoritative host", () => {
    const run = {
      run_id: "00000000-2000-4000-8000-000000000002",
      status: "preparing",
      max_projects: 10,
    } as any;
    expect(
      __test__.shouldReconcileRunWithRuntime(run, {
        run_id: run.run_id,
        status: "ready",
        admission_open: false,
        active_projects: 0,
      }),
    ).toBe(true);
    expect(
      __test__.shouldReconcileRunWithRuntime(run, {
        run_id: run.run_id,
        status: "preparing",
        admission_open: false,
        active_projects: 0,
      }),
    ).toBe(false);
    expect(
      __test__.shouldReconcileRunWithRuntime(
        { ...run, status: "open" },
        {
          run_id: run.run_id,
          status: "open",
          admission_open: true,
          active_projects: 10,
          max_projects: 11,
        },
      ),
    ).toBe(true);
    expect(
      __test__.shouldReconcileRunWithRuntime(run, {
        run_id: "00000000-3000-4000-8000-000000000003",
        status: "ready",
        admission_open: false,
        active_projects: 0,
      }),
    ).toBe(false);
  });
});
