/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AddressInfo } from "node:net";
import express from "express";

const getAccountId = jest.fn();
jest.mock("@cocalc/server/auth/get-account", () => ({
  __esModule: true,
  default: (req: any) => getAccountId(req),
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: () => "h".repeat(127),
}));
jest.mock("@cocalc/server/conat/api/hosts", () => ({
  issueProjectAppUrl: jest.fn(),
}));
jest.mock("@cocalc/backend/base-path", () => ({ __esModule: true, default: "/" }));
jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({ debug: jest.fn() }),
}));

import { initAppOpen } from "./app-open";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const LINK = "https://ap8000-x.h-y.content.test/_a/CAP?next=%2Fp";

describe("app open", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  const issue = jest.fn();
  beforeEach(async () => {
    issue.mockReset();
    getAccountId.mockReset();
    getAccountId.mockResolvedValue(ACCOUNT);
    issue.mockResolvedValue({ url: LINK, expires_at: 0 });
    const app = express();
    const router = express.Router();
    initAppOpen(router, { issue });
    app.use("/", router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: "manual", headers });
  const sameOrigin = {
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Dest": "document",
  };

  it("redirects a same-origin navigation to the app origin, keeping the referrer", async () => {
    const res = await get(
      `/app-open/${PROJECT}/port/8000/a%20b/?x=1&app=ignored-for-port`,
      sameOrigin,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(LINK);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).not.toBe("no-referrer");
    expect(issue).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      session_hash: "h".repeat(127),
      project_id: PROJECT,
      path: `/${PROJECT}/port/8000/a%20b/?x=1`,
      app_id: "ignored-for-port",
    });
  });

  it("asks first for anything not same-origin, linking back here", async () => {
    for (const site of ["cross-site", "same-site", "none", ""]) {
      const headers: Record<string, string> = { "Sec-Fetch-Dest": "document" };
      if (site) headers["Sec-Fetch-Site"] = site;
      const res = await get(`/app-open/${PROJECT}/port/8000/`, headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      const html = await res.text();
      expect(html).toContain('<a href="">');
      expect(html).not.toContain("8000");
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("never reflects the path into the page", async () => {
    const res = await get(`/app-open/${PROJECT}/port/8000/%3Cb%3Ex%3C%2Fb%3E`, {
      "Sec-Fetch-Site": "cross-site",
    });
    const html = await res.text();
    expect(html).not.toMatch(/%3C|<b>x/);
  });

  it("refuses subresource and frame loads", async () => {
    for (const dest of ["iframe", "script", "empty", "image"]) {
      const res = await get(`/app-open/${PROJECT}/port/8000/`, {
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Dest": dest,
      });
      expect(res.status).toBe(403);
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("falls back to the project when there is no app origin or no sign-in", async () => {
    issue.mockResolvedValue({ unavailable: "off" });
    let res = await get(`/app-open/${PROJECT}/port/8000/a?b=1`, sameOrigin);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/${PROJECT}/port/8000/a?b=1`);

    issue.mockResolvedValue({ unavailable: "host-not-ready" });
    res = await get(`/app-open/${PROJECT}/port/8000/`, sameOrigin);
    expect(res.headers.get("location")).toBe(`/${PROJECT}/port/8000/`);

    issue.mockResolvedValue({ unavailable: "no-access" });
    res = await get(`/app-open/${PROJECT}/port/8000/`, sameOrigin);
    expect(res.headers.get("location")).toBe(`/projects/${PROJECT}`);

    issue.mockRejectedValue(new Error("not an app route"));
    res = await get(`/app-open/${PROJECT}/files/a.html`, sameOrigin);
    expect(res.headers.get("location")).toBe(`/projects/${PROJECT}`);

    issue.mockReset();
    getAccountId.mockResolvedValue(undefined);
    res = await get(`/app-open/${PROJECT}/port/8000/`, sameOrigin);
    expect(res.headers.get("location")).toBe(`/projects/${PROJECT}`);
    expect(issue).not.toHaveBeenCalled();
  });

  it("never sends a request from the project host back there", async () => {
    issue.mockResolvedValue({ url: LINK, expires_at: 0 });
    let res = await get(
      `/app-open/${PROJECT}/port/8000/a?b=1&cocalc_app_redirect=1`,
      sameOrigin,
    );
    expect(res.headers.get("location")).toBe(LINK);
    expect(issue).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: `/${PROJECT}/port/8000/a?b=1` }),
    );
    issue.mockResolvedValue({ unavailable: "host-not-ready" });
    res = await get(
      `/app-open/${PROJECT}/port/8000/?cocalc_app_redirect=1`,
      sameOrigin,
    );
    expect(res.headers.get("location")).toBe(`/projects/${PROJECT}`);
  });

  it("does not issue for bearer-authenticated requests", async () => {
    const res = await get(`/app-open/${PROJECT}/port/8000/`, {
      ...sameOrigin,
      Authorization: "Bearer x",
    });
    expect(res.status).toBe(302);
    expect(issue).not.toHaveBeenCalled();
  });

  it("404s an invalid project id", async () => {
    expect((await get(`/app-open/nope/port/8000/`, sameOrigin)).status).toBe(404);
  });
});
