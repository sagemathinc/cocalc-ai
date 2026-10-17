/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  APP_HOSTNAME_ROUTING_PENDING_URL,
  createAppHostnameRequestRewriteBarrier,
  createPrivateAppHostnameRequestRewriter,
  privateAppHostnameExternalLocation,
  PRIVATE_APP_HOST_HEADER,
  rewritePrivateAppHostnameResponseLocation,
  rewritePrivateAppHostnameUrl,
  getPrivateAppHostnameProject,
} from "./private-app-hostname";

const route = {
  project_id: "11111111-1111-4111-8111-111111111111",
  app_id: "dev-site",
  base_path: "/apps/dev-site",
};

describe("private app hostname routing", () => {
  it("maps hostname-root requests to the private managed app", () => {
    expect(
      rewritePrivateAppHostnameUrl({
        originalUrl: "/auth/sign-in?next=%2F",
        route,
      }),
    ).toBe(
      "/11111111-1111-4111-8111-111111111111/apps/dev-site/auth/sign-in?next=%2F",
    );
  });

  it("preserves the hostname-root trailing slash", () => {
    expect(
      rewritePrivateAppHostnameUrl({
        originalUrl: "/",
        route,
      }),
    ).toBe(`/${route.project_id}/apps/dev-site/`);
    expect(
      rewritePrivateAppHostnameUrl({
        originalUrl: "/docs/",
        route,
      }),
    ).toBe(`/${route.project_id}/apps/dev-site/docs/`);
  });

  it("does not duplicate an already canonical route", () => {
    expect(
      rewritePrivateAppHostnameUrl({
        originalUrl:
          "/11111111-1111-4111-8111-111111111111/apps/dev-site/api/status",
        route,
      }),
    ).toBe("/11111111-1111-4111-8111-111111111111/apps/dev-site/api/status");
  });

  it("traces, caches, marks, and rewrites private hostname requests", async () => {
    const trace = jest.fn(async () => ({ matched: true, ...route }));
    const rewrite = createPrivateAppHostnameRequestRewriter({ trace });
    const first = {
      headers: { host: "DEV-1234.EXAMPLE.COM:443" },
      url: "/auth/sign-in?next=%2F",
    } as any;
    const second = {
      headers: { host: "dev-1234.example.com" },
      url: "/api/status",
    } as any;

    await rewrite(first);
    await rewrite(second);

    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace).toHaveBeenCalledWith("dev-1234.example.com");
    expect(first.headers[PRIVATE_APP_HOST_HEADER]).toBe("dev-1234.example.com");
    expect(first.url).toBe(
      "/11111111-1111-4111-8111-111111111111/apps/dev-site/auth/sign-in?next=%2F",
    );
    expect(second.url).toBe(
      "/11111111-1111-4111-8111-111111111111/apps/dev-site/api/status",
    );
  });

  it("shares an in-flight hostname trace across upgrade listeners", async () => {
    let resolveTrace!: (value: { matched: true } & typeof route) => void;
    const trace = jest.fn(
      async () =>
        await new Promise<{ matched: true } & typeof route>((resolve) => {
          resolveTrace = resolve;
        }),
    );
    const rewrite = createPrivateAppHostnameRequestRewriter({ trace });
    const req = {
      headers: { host: "dev-1234.example.com" },
      url: "/conat/?EIO=4&transport=websocket",
    } as any;

    const projectProxyRewrite = rewrite(req);
    const outerConatRewrite = rewrite(req);

    expect(trace).toHaveBeenCalledTimes(1);
    resolveTrace({ matched: true, ...route });
    await Promise.all([projectProxyRewrite, outerConatRewrite]);

    expect(req.url).toBe(
      `/${route.project_id}/apps/dev-site/conat/?EIO=4&transport=websocket`,
    );
    expect(req.headers[PRIVATE_APP_HOST_HEADER]).toBe("dev-1234.example.com");
  });

  it("synchronously claims custom-host upgrades during async routing", async () => {
    let resolveRewrite!: () => void;
    const routed = new Promise<void>((resolve) => {
      resolveRewrite = resolve;
    });
    const rewrite = jest.fn(
      async (req: any, originalUrl: string): Promise<void> => {
        await routed;
        req.url = `/routed${originalUrl}`;
      },
    );
    const barrier = createAppHostnameRequestRewriteBarrier({
      shouldClaim: () => true,
      rewrite,
    });
    const req = {
      headers: { host: "dev-1234.example.com" },
      url: "/conat/?EIO=4&transport=websocket",
    } as any;

    const projectProxyRewrite = barrier(req);
    const infrastructureConatRewrite = barrier(req);

    expect(req.url).toBe(APP_HOSTNAME_ROUTING_PENDING_URL);
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite).toHaveBeenCalledWith(
      req,
      "/conat/?EIO=4&transport=websocket",
    );

    resolveRewrite();
    await Promise.all([projectProxyRewrite, infrastructureConatRewrite]);
    expect(req.url).toBe("/routed/conat/?EIO=4&transport=websocket");
  });

  it("does not mask a request that an earlier middleware already routed", async () => {
    const rewrite = jest.fn(async () => {});
    const barrier = createAppHostnameRequestRewriteBarrier({
      shouldClaim: () => false,
      rewrite,
    });
    const req = {
      headers: {
        host: "dev-1234.example.com",
        [PRIVATE_APP_HOST_HEADER]: "dev-1234.example.com",
      },
      url: `/${route.project_id}/apps/dev-site/`,
    } as any;

    await barrier(req);

    expect(req.url).toBe(`/${route.project_id}/apps/dev-site/`);
    expect(rewrite).toHaveBeenCalledWith(
      req,
      `/${route.project_id}/apps/dev-site/`,
    );
  });

  it("leaves canonical project-host routes unchanged", async () => {
    const trace = jest.fn();
    const rewrite = createPrivateAppHostnameRequestRewriter({ trace });
    const req = {
      headers: { host: "dev-1234.example.com" },
      url: `/${route.project_id}/apps/dev-site/`,
    } as any;

    await rewrite(req);

    // The hostname is looked up (and cached) so the origin policy knows
    // whether the page is a private app, but the route is not rewritten.
    expect(trace).toHaveBeenCalledTimes(1);
    expect(req.url).toBe(`/${route.project_id}/apps/dev-site/`);
    expect(req.headers[PRIVATE_APP_HOST_HEADER]).toBeUndefined();
    expect(getPrivateAppHostnameProject(req)).toBeUndefined();
  });

  it("records the private app's project on explicit project paths without rewriting them", async () => {
    const rewrite = createPrivateAppHostnameRequestRewriter({
      trace: async () => ({ matched: true, ...route }),
    });
    const other = "00000000-1000-4000-8000-0000000000aa";
    const req = {
      headers: { host: "dev-1234.example.com" },
      url: `/${other}/apps/x/`,
    } as any;
    await rewrite(req);
    expect(req.url).toBe(`/${other}/apps/x/`);
    expect(req.headers[PRIVATE_APP_HOST_HEADER]).toBeUndefined();
    expect(getPrivateAppHostnameProject(req)).toBe(route.project_id);
  });

  it("maps internal redirect locations back to the private hostname root", async () => {
    const rewrite = createPrivateAppHostnameRequestRewriter({
      trace: async () => ({ matched: true, ...route }),
    });
    const req = {
      headers: { host: "dev-1234.example.com" },
      url: "/",
    } as any;
    await rewrite(req);

    expect(
      privateAppHostnameExternalLocation(
        req,
        `/${route.project_id}/apps/dev-site`,
      ),
    ).toBe("/");
    expect(
      privateAppHostnameExternalLocation(
        req,
        `/${route.project_id}/apps/dev-site/static/app.html?target=%2Fprojects`,
      ),
    ).toBe("/static/app.html?target=%2Fprojects");
    expect(
      privateAppHostnameExternalLocation(
        req,
        "https://other.example.com/11111111-1111-4111-8111-111111111111/apps/dev-site/",
      ),
    ).toBe(
      "https://other.example.com/11111111-1111-4111-8111-111111111111/apps/dev-site/",
    );

    const proxyRes = {
      headers: {
        location: `/${route.project_id}/apps/dev-site/auth/sign-in`,
      },
    } as any;
    rewritePrivateAppHostnameResponseLocation(proxyRes, req);
    expect(proxyRes.headers.location).toBe("/auth/sign-in");
  });
});
