import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@jest/globals";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";

// Root installs (cocalc-runtime-artifacts), simulated on the filesystem.
const mockRoot: { dir: string; layout?: { root: string; current: string } } = {
  dir: "",
};
const mockCalls: any[] = [];
// what root may do in the directory the daemon can't write
function mockAsRoot<T>(work: () => T): T {
  const fs = require("node:fs");
  fs.chmodSync(mockRoot.dir, 0o755);
  try {
    return work();
  } finally {
    fs.chmodSync(mockRoot.dir, 0o555);
  }
}
jest.mock("./artifact-install", () => ({
  rootArtifactLayout: async () => mockRoot.layout,
  rootInstallArtifact: async (kind: string, version: string, base: string) => {
    mockCalls.push(["install", kind, version, base]);
    return mockAsRoot(() => {
      const dir = require("node:path").join(mockRoot.dir, version);
      require("node:fs").mkdirSync(dir, { recursive: true });
      require("node:fs").writeFileSync(
        require("node:path").join(dir, "README.txt"),
        `${version}\n`,
      );
      return "installed";
    });
  },
  rootSetCurrentArtifact: async (
    kind: string,
    version: string,
    { link = "current" }: { link?: string } = {},
  ) => {
    mockCalls.push(["set", kind, version, link]);
    mockAsRoot(() => {
      const p = require("node:path");
      const linkPath = p.join(mockRoot.dir, link);
      require("node:fs").rmSync(linkPath, { force: true });
      require("node:fs").symlinkSync(p.join(mockRoot.dir, version), linkPath);
    });
  },
  rootClearCurrentArtifact: async (kind: string) => {
    mockCalls.push(["clear", kind]);
    mockAsRoot(() =>
      require("node:fs").rmSync(
        require("node:path").join(mockRoot.dir, "current"),
        {
          force: true,
        },
      ),
    );
  },
  rootPruneArtifact: async (kind: string, version: string) => {
    mockCalls.push(["prune", kind, version]);
    mockAsRoot(() =>
      require("node:fs").rmSync(
        require("node:path").join(mockRoot.dir, version),
        { recursive: true, force: true },
      ),
    );
    return "removed";
  },
}));

import { __test__, activateInstalledProjectHostVersion } from "./upgrade";

describe("project host upgrades through root installs", () => {
  afterEach(() => {
    closeDatabase();
    delete process.env.COCALC_DATA;
    delete process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL;
    mockRoot.layout = undefined;
    mockCalls.length = 0;
  });

  it("has root install even a version whose directory exists (it may be legacy)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-root-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const bundlesRoot = path.join(base, "bundles");
      mockRoot.dir = bundlesRoot;
      fs.mkdirSync(path.join(bundlesRoot, "v04"), { recursive: true });
      fs.writeFileSync(path.join(bundlesRoot, "v04", "README.txt"), "legacy");
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v04"), currentLink);
      fs.chmodSync(bundlesRoot, 0o555);
      const resolved = {
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v04",
        url: "https://unused.example.invalid/never-fetched",
        stripComponents: 1,
        root: bundlesRoot,
        versionDir: path.join(bundlesRoot, "v04"),
        currentLink,
        rootInstall: true,
        baseUrl: "https://software.example.invalid/software",
      } as any;
      // the current version, but root just installed it again: not a noop
      const result = await __test__.downloadAndInstall(resolved);
      expect(mockCalls[0]).toEqual([
        "install",
        "project-host",
        "v04",
        "https://software.example.invalid/software",
      ]);
      expect(result.status).toBe("updated");
      // a failed first activation goes back to no current link, through root
      mockCalls.length = 0;
      await __test__.clearArtifactLink(resolved, currentLink);
      expect(mockCalls).toEqual([["clear", "project-host"]]);
      expect(fs.existsSync(currentLink)).toBe(false);
    } finally {
      fs.chmodSync(mockRoot.dir, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("installs, switches and prunes as root, never writing the program directory itself", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-root-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const bundlesRoot = path.join(base, "bundles");
      mockRoot.dir = bundlesRoot;
      for (const version of ["v01", "v02", "v03", "v04"]) {
        fs.mkdirSync(path.join(bundlesRoot, version), { recursive: true });
        fs.writeFileSync(path.join(bundlesRoot, version, "README.txt"), "x");
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v04"), currentLink);
      // root's directory: the daemon can't write it
      fs.chmodSync(bundlesRoot, 0o555);
      const result = await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v05",
        url: "https://unused.example.invalid/never-fetched",
        stripComponents: 1,
        root: bundlesRoot,
        versionDir: path.join(bundlesRoot, "v05"),
        currentLink,
        rootInstall: true,
        baseUrl: "https://software.example.invalid/software",
        retentionPolicy: { "project-host": { keep_count: 3 } },
      } as any);
      expect(result.status).toBe("updated");
      expect(mockCalls).toEqual([
        [
          "install",
          "project-host",
          "v05",
          "https://software.example.invalid/software",
        ],
        // the version to go back to is root's too before the switch
        [
          "install",
          "project-host",
          "v04",
          "https://software.example.invalid/software",
        ],
        ["set", "project-host", "v05", "current"],
        ["prune", "project-host", "v02"],
        ["prune", "project-host", "v01"],
      ]);
      expect(fs.realpathSync(currentLink)).toBe(path.join(bundlesRoot, "v05"));
    } finally {
      fs.chmodSync(mockRoot.dir, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("has root install a rollback target before switching to it (it may be legacy)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-root-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_PROJECT_HOST_SOFTWARE_BASE_URL =
        "https://software.example.invalid/software";
      const bundlesRoot = path.join(base, "bundles");
      mockRoot.dir = bundlesRoot;
      for (const version of ["v03", "v04"]) {
        fs.mkdirSync(path.join(bundlesRoot, version), { recursive: true });
        fs.writeFileSync(path.join(bundlesRoot, version, "README.txt"), "x");
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v04"), currentLink);
      fs.chmodSync(bundlesRoot, 0o555);
      mockRoot.layout = { root: bundlesRoot, current: currentLink };
      await activateInstalledProjectHostVersion("v03");
      expect(mockCalls).toEqual([
        [
          "install",
          "project-host",
          "v03",
          "https://software.example.invalid/software",
        ],
        ["set", "project-host", "v03", "current"],
      ]);
      expect(fs.realpathSync(currentLink)).toBe(path.join(bundlesRoot, "v03"));
    } finally {
      fs.chmodSync(mockRoot.dir, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("doesn't switch when current isn't a version it could go back to", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-root-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const bundlesRoot = path.join(base, "bundles");
      mockRoot.dir = bundlesRoot;
      fs.mkdirSync(path.join(base, "elsewhere", "v04"), { recursive: true });
      fs.mkdirSync(bundlesRoot, { recursive: true });
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(base, "elsewhere", "v04"), currentLink);
      fs.chmodSync(bundlesRoot, 0o555);
      await expect(
        __test__.downloadAndInstall({
          artifact: "project-host",
          canonicalArtifact: "project-host",
          version: "v05",
          url: "https://unused.example.invalid/never-fetched",
          stripComponents: 1,
          root: bundlesRoot,
          versionDir: path.join(bundlesRoot, "v05"),
          currentLink,
          rootInstall: true,
          baseUrl: "https://software.example.invalid/software",
        } as any),
      ).rejects.toThrow("not switching without a version to go back to");
      expect(mockCalls.map((call) => call[0])).toEqual(["install"]);
      expect(fs.realpathSync(currentLink)).toBe(
        path.join(base, "elsewhere", "v04"),
      );
    } finally {
      fs.chmodSync(mockRoot.dir, 0o755);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
