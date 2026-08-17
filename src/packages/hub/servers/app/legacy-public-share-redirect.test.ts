/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AddressInfo } from "node:net";
import express from "express";

import initLegacyPublicShareRedirect from "./legacy-public-share-redirect";

jest.mock("@cocalc/server/conat/api/public-directory-shares", () => ({
  resolveLegacyPublicDirectorySharePath: jest.fn(async () => null),
}));

describe("legacy public share redirects", () => {
  async function request({
    path,
    resolve,
  }: {
    path: string;
    resolve: jest.Mock;
  }) {
    const app = express();
    const router = express.Router();
    initLegacyPublicShareRedirect(router, { resolve });
    app.use(router);
    const server = await new Promise<ReturnType<typeof app.listen>>((done) => {
      const next = app.listen(0, "127.0.0.1", () => done(next));
    });
    try {
      const { port } = server.address() as AddressInfo;
      return await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
      });
    } finally {
      await new Promise<void>((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      });
    }
  }

  it("redirects a known vanity path to the public share route", async () => {
    const resolve = jest.fn(async () => ({
      path: "georeg/matrix-certificates/notebook",
    }));
    const response = await request({
      path: "/legacy/georeg/matrix-certificates/notebook?viewer=share",
      resolve,
    });

    expect(resolve).toHaveBeenCalledWith({
      path: "georeg/matrix-certificates/notebook",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/share/georeg/matrix-certificates/notebook?viewer=share",
    );
    expect(response.headers.get("x-cocalc-legacy-redirect")).toBe(
      "public-share",
    );
  });

  it("decodes once for lookup and safely encodes the redirect", async () => {
    const resolve = jest.fn(async ({ path }) => ({
      path: path.replace(/^share\//, ""),
    }));
    const response = await request({
      path: "/legacy/share/public_paths/legacy-id/files/a%20b.ipynb",
      resolve,
    });

    expect(resolve).toHaveBeenCalledWith({
      path: "share/public_paths/legacy-id/files/a b.ipynb",
    });
    expect(response.headers.get("location")).toBe(
      "/share/public_paths/legacy-id/files/a%20b.ipynb",
    );
  });

  it("preserves current routing when no legacy share matches", async () => {
    const response = await request({
      path: "/legacy/features/terminal?source=old",
      resolve: jest.fn(async () => null),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/features/terminal?source=old",
    );
    expect(response.headers.get("x-cocalc-legacy-redirect")).toBe(
      "path-preserving-fallback",
    );
  });

  it("falls back instead of failing when directory lookup is unavailable", async () => {
    const response = await request({
      path: "/legacy/pricing",
      resolve: jest.fn(async () => {
        throw Error("directory unavailable");
      }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/pricing");
  });

  it("never emits a protocol-relative fallback redirect", async () => {
    const response = await request({
      path: "/legacy//example.com/path",
      resolve: jest.fn(async () => null),
    });

    expect(response.headers.get("location")).toBe("/example.com/path");
  });

  it("rejects encoded path separators before lookup", async () => {
    const resolve = jest.fn(async () => null);
    const response = await request({
      path: "/legacy/georeg%2Fother/notebook",
      resolve,
    });

    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });
});
