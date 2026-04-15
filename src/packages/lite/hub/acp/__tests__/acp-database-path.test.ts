import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

describe("ACP sqlite path binding", () => {
  const originalDataDir = process.env.COCALC_DATA_DIR;
  const originalData = process.env.DATA;

  afterEach(async () => {
    jest.resetModules();
    if (originalDataDir === undefined) {
      delete process.env.COCALC_DATA_DIR;
    } else {
      process.env.COCALC_DATA_DIR = originalDataDir;
    }
    if (originalData === undefined) {
      delete process.env.DATA;
    } else {
      process.env.DATA = originalData;
    }
  });

  it("keeps using the original lite data dir after cleanup clears env overrides", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "lite-acp-path-binding-"),
    );
    try {
      process.env.COCALC_DATA_DIR = tempDir;
      process.env.DATA = tempDir;
      jest.resetModules();
      const acpDatabase = await import("../../sqlite/acp-database");

      delete process.env.COCALC_DATA_DIR;
      delete process.env.DATA;

      acpDatabase.closeAcpDatabase();
      acpDatabase.initAcpDatabase();

      expect(acpDatabase.getAcpDatabaseFilename()).toBe(
        path.join(tempDir, "acp.sqlite"),
      );

      acpDatabase.closeAcpDatabase();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
