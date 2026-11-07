/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  applyBrowserCors: async () => {},
}));

jest.mock("./launchpad-routes", () => ({
  __esModule: true,
  getLaunchpadApiV2Routes: () => [],
}));

import createApiV2Router, { isRawBodyRoute } from "./router";

describe("routes that read their own bodies", () => {
  let server: Server;
  let base: string;
  const seen: Record<string, { body: unknown; raw: string }> = {};

  function recorder(name: string) {
    return async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      seen[name] = {
        body: req.body,
        raw: Buffer.concat(chunks).toString(),
      };
      res.json({ ok: true });
    };
  }

  beforeAll(async () => {
    const app = express();
    app.use(
      "/api/v2",
      createApiV2Router({
        routes: [
          { path: "/support/sagebrush-intake", handler: recorder("intake") },
          { path: "/support/create-ticket", handler: recorder("public") },
        ],
      }),
    );
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("matches the intake path as Express does", () => {
    expect(isRawBodyRoute("/support/sagebrush-intake")).toBe(true);
    expect(isRawBodyRoute("/support/sagebrush-intake/")).toBe(true);
    expect(isRawBodyRoute("/Support/Sagebrush-Intake")).toBe(true);
    expect(isRawBodyRoute("/support/create-ticket")).toBe(false);
    expect(isRawBodyRoute("/support/sagebrush-intake-x")).toBe(false);
  });

  it.each(["/support/sagebrush-intake", "/Support/Sagebrush-Intake/"])(
    "leaves the body of %s unread for its handler",
    async (path) => {
      const payload = '{"a":"1","a":"2"}';
      await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(seen.intake.raw).toBe(payload);
      expect(seen.intake.body).toBeUndefined();
    },
  );

  it("still parses the body of other routes", async () => {
    await fetch(`${base}/support/create-ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"options":{"email":"user@example.com"}}',
    });
    expect(seen.public.body).toEqual({
      options: { email: "user@example.com" },
    });
    expect(seen.public.raw).toBe("");
  });
});
