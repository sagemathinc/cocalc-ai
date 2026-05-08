/** @jest-environment node */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { discoverApiV2Routes } from "./api-v2-routes";

describe("discoverApiV2Routes", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("discovers handlers directly from the api/v2 filesystem layout", () => {
    const root = mkdtempSync(join(tmpdir(), "http-api-routes-"));
    try {
      mkdirSync(join(root, "auth"), { recursive: true });
      writeFileSync(
        join(root, "index.js"),
        "module.exports = function docs(_req, res) { res.end('docs'); };\n",
      );
      writeFileSync(
        join(root, "auth", "sign-in.js"),
        "module.exports = function signIn(_req, res) { res.end('sign-in'); };\n",
      );
      writeFileSync(
        join(root, "auth", "ignored.test.js"),
        "module.exports = function ignored() {};\n",
      );

      const withoutDocs = discoverApiV2Routes({
        rootDir: root,
        includeDocs: false,
        ensureLibAlias: false,
        logger: logger as any,
      });
      expect(withoutDocs.map(({ path }) => path)).toEqual(["/auth/sign-in"]);

      const withDocs = discoverApiV2Routes({
        rootDir: root,
        includeDocs: true,
        ensureLibAlias: false,
        logger: logger as any,
      });
      expect(withDocs.map(({ path }) => path)).toEqual(["/auth/sign-in", "/"]);
      expect(
        withDocs.every(({ handler }) => typeof handler === "function"),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
