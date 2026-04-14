/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isProjectHostExternalConatRouterEnabled,
  resolveProjectHostConatRouterClusterName,
  resolveProjectHostConatRouterUrl,
  rewriteProjectHostConatProxyUrl,
} from "./conat-router";

describe("project-host conat router helpers", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    delete process.env.COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("detects external router mode from env", () => {
    delete process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER;
    expect(isProjectHostExternalConatRouterEnabled()).toBe(false);

    process.env.COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER = "1";
    expect(isProjectHostExternalConatRouterEnabled()).toBe(true);
  });

  it("resolves the external router url from explicit url or local port", () => {
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL = "http://127.0.0.1:9911";
    expect(resolveProjectHostConatRouterUrl()).toBe("http://127.0.0.1:9911");

    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT = "9922";
    expect(resolveProjectHostConatRouterUrl()).toBe("http://127.0.0.1:9922");
  });

  it("requires explicit external router bootstrap config", () => {
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_URL;
    delete process.env.COCALC_PROJECT_HOST_CONAT_ROUTER_PORT;
    expect(() => resolveProjectHostConatRouterUrl()).toThrow(
      /external conat router mode requires/i,
    );
  });

  it("defaults router cluster naming only when local clustering is enabled", () => {
    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 1,
      }),
    ).toBeUndefined();

    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 3,
      }),
    ).toBe("project-host-router-host-123");

    process.env.COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME = "explicit-cluster";
    expect(
      resolveProjectHostConatRouterClusterName({
        hostId: "host-123",
        localClusterSize: 2,
      }),
    ).toBe("explicit-cluster");
  });

  it("rewrites proxied conat urls down to the router path", () => {
    expect(rewriteProjectHostConatProxyUrl("/conat/?EIO=4")).toBe(
      "/conat/?EIO=4",
    );
    expect(rewriteProjectHostConatProxyUrl("/host/base/conat/?EIO=4")).toBe(
      "/conat/?EIO=4",
    );
    expect(rewriteProjectHostConatProxyUrl("/api/not-conat")).toBeUndefined();
    expect(
      rewriteProjectHostConatProxyUrl("/host/base/conat/socket"),
    ).toBeUndefined();
  });
});
