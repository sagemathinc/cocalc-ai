/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("app expose launchpad reservation", () => {
  const originalHome = process.env.HOME;
  const originalProduct = process.env.COCALC_PRODUCT;
  const testHome = mkdtempSync(join(tmpdir(), "cocalc-app-expose-launchpad-"));

  afterAll(() => {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalProduct == null) {
      delete process.env.COCALC_PRODUCT;
    } else {
      process.env.COCALC_PRODUCT = originalProduct;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  test("uses the hub policy path even when COCALC_PRODUCT is absent in the workspace env", async () => {
    process.env.HOME = testHome;
    delete process.env.COCALC_PRODUCT;

    const getPolicy = jest.fn(async () => ({
      enabled: true,
      warnings: [],
    }));
    const reserve = jest.fn(async () => ({
      hostname: "abcd-app.host-123.dev.cocalc.ai",
      label: "abcd",
      url_public: "https://abcd-app.host-123.dev.cocalc.ai",
      warnings: [],
    }));

    jest.resetModules();
    jest.doMock("@cocalc/conat/client", () => ({
      conat: jest.fn(() => ({})),
      getClient: jest.fn(() => ({
        conat: jest.fn(() => ({})),
      })),
    }));
    jest.doMock("@cocalc/project/conat/hub", () => ({
      hubApi: jest.fn(() => ({
        system: {
          getProjectAppPublicPolicy: getPolicy,
          reserveProjectAppPublicSubdomain: reserve,
          releaseProjectAppPublicSubdomain: jest.fn(async () => ({
            released: true,
          })),
        },
      })),
    }));

    const { exposeApp, upsertAppSpec, deleteApp, statusApp } =
      await import("./control");

    const id = `launchpad-${Date.now()}`;
    await upsertAppSpec({
      version: 1,
      id,
      kind: "service",
      title: "Launchpad reservation test",
      command: {
        exec: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      network: { listen_host: "127.0.0.1", port: 6123, protocol: "http" },
      proxy: { base_path: `/apps/${id}`, strip_prefix: true, websocket: false },
      wake: { enabled: false, keep_warm_s: 1, startup_timeout_s: 15 },
    });

    const exposed = await exposeApp({
      id,
      ttl_s: 600,
      auth_front: "none",
      random_subdomain: true,
    });

    expect(getPolicy).toHaveBeenCalled();
    expect(getPolicy).toHaveBeenCalledWith({ project_id: expect.any(String) });
    expect(reserve).toHaveBeenCalledWith({
      project_id: expect.any(String),
      app_id: id,
      base_path: `/apps/${id}`,
      ttl_s: 600,
      preferred_label: undefined,
      random_subdomain: true,
    });
    expect(exposed.exposure?.public_url).toBe(
      "https://abcd-app.host-123.dev.cocalc.ai",
    );

    await deleteApp(id);
    await statusApp(id).catch(() => undefined);
  });
});
