import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@jest/globals";
import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";

import { __test__ } from "./upgrade";
import { upsertProject } from "./sqlite/projects";

function createArchive(base: string): string {
  const sourceRoot = path.join(base, "archive-root");
  const payloadDir = path.join(sourceRoot, "bundle");
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(
    path.join(payloadDir, "README.txt"),
    "project-host bundle\n",
  );
  const archivePath = path.join(base, "bundle.tar.xz");
  execFileSync("tar", ["-cJf", archivePath, "-C", sourceRoot, "bundle"]);
  return archivePath;
}

async function serveFile(filePath: string): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = http.createServer((_, res) => {
    fs.createReadStream(filePath).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unable to determine test server address");
  }
  return {
    url: `http://127.0.0.1:${address.port}/bundle.tar.xz`,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

afterEach(() => {
  delete process.env.COCALC_DATA;
  delete process.env.COCALC_LITE_SQLITE_FILENAME;
  delete process.env.COCALC_PROJECT_HOST_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_HOST_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PROJECT_BUNDLE_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_BUNDLE_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PROJECT_TOOLS_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_TOOLS_RETENTION_MAX_BYTES;
  closeDatabase();
});

describe("project host upgrade installer", () => {
  it("prepares the current-link parent separately from the bundle root", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const bundlesRoot = path.join(base, "project-host-bundles");
      const currentLink = path.join(base, "project-host-current", "current");
      const versionDir = path.join(bundlesRoot, "v1");
      const result = await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v1",
        url: served.url,
        stripComponents: 1,
        root: bundlesRoot,
        versionDir,
        currentLink,
      } as any);

      expect(result).toMatchObject({
        artifact: "project-host",
        status: "updated",
        version: "v1",
      });
      expect(fs.realpathSync(currentLink)).toBe(versionDir);
      expect(fs.readFileSync(path.join(versionDir, "README.txt"), "utf8")).toBe(
        "project-host bundle\n",
      );
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("prunes old version directories after switching current", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const bundlesRoot = path.join(base, "project-host-bundles");
      fs.mkdirSync(bundlesRoot, { recursive: true });
      for (const version of [
        "v01",
        "v02",
        "v03",
        "v04",
        "v05",
        "v06",
        "v07",
        "v08",
        "v09",
        "v10",
        "v11",
        "v12",
      ]) {
        const dir = path.join(bundlesRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "README.txt"), `${version}\n`);
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v12"), currentLink);
      const versionDir = path.join(bundlesRoot, "v13");
      await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v13",
        url: served.url,
        stripComponents: 1,
        root: bundlesRoot,
        versionDir,
        currentLink,
      } as any);

      const versions = fs
        .readdirSync(bundlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "current")
        .map((entry) => entry.name)
        .sort();
      expect(versions).toEqual([
        "v04",
        "v05",
        "v06",
        "v07",
        "v08",
        "v09",
        "v10",
        "v11",
        "v12",
        "v13",
      ]);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("respects env-configured project-host retention counts", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_PROJECT_HOST_RETENTION_COUNT = "5";
      const bundlesRoot = path.join(base, "project-host-bundles");
      fs.mkdirSync(bundlesRoot, { recursive: true });
      for (const version of ["v01", "v02", "v03", "v04", "v05", "v06"]) {
        const dir = path.join(bundlesRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "README.txt"), `${version}\n`);
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v06"), currentLink);
      const versionDir = path.join(bundlesRoot, "v07");
      await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v07",
        url: served.url,
        stripComponents: 1,
        root: bundlesRoot,
        versionDir,
        currentLink,
      } as any);

      const versions = fs
        .readdirSync(bundlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "current")
        .map((entry) => entry.name)
        .sort();
      expect(versions).toEqual(["v03", "v04", "v05", "v06", "v07"]);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("retains additional recent versions while within the byte budget", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      const bundlesRoot = path.join(base, "project-bundles");
      fs.mkdirSync(bundlesRoot, { recursive: true });
      const versions = ["bundle-1", "bundle-2", "bundle-3", "bundle-4"];
      let when = Date.parse("2026-04-19T00:00:00.000Z");
      for (const version of versions) {
        const dir = path.join(bundlesRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(1024));
        fs.utimesSync(dir, when / 1000, when / 1000);
        when += 1000;
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "bundle-4"), currentLink);
      const desiredDir = path.join(bundlesRoot, "bundle-5");
      fs.mkdirSync(desiredDir, { recursive: true });
      fs.writeFileSync(
        path.join(desiredDir, "payload.bin"),
        Buffer.alloc(1024),
      );
      fs.utimesSync(desiredDir, when / 1000, when / 1000);

      await __test__.pruneVersionDirs({
        root: bundlesRoot,
        currentLink,
        desiredDir,
        keep: 2,
        maxBytes: 3072,
      });

      const retained = fs
        .readdirSync(bundlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(retained).toEqual(["bundle-3", "bundle-4", "bundle-5"]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves protected versions even when they exceed the byte budget", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      const toolsRoot = path.join(base, "tools");
      fs.mkdirSync(toolsRoot, { recursive: true });
      const versions = ["tools-1", "tools-2", "tools-3", "tools-4"];
      let when = Date.parse("2026-04-19T01:00:00.000Z");
      for (const version of versions) {
        const dir = path.join(toolsRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(1024));
        fs.utimesSync(dir, when / 1000, when / 1000);
        when += 1000;
      }
      const currentLink = path.join(toolsRoot, "current");
      fs.symlinkSync(path.join(toolsRoot, "tools-4"), currentLink);
      const desiredDir = path.join(toolsRoot, "tools-5");
      fs.mkdirSync(desiredDir, { recursive: true });
      fs.writeFileSync(
        path.join(desiredDir, "payload.bin"),
        Buffer.alloc(1024),
      );
      fs.utimesSync(desiredDir, when / 1000, when / 1000);

      await __test__.pruneVersionDirs({
        root: toolsRoot,
        currentLink,
        desiredDir,
        keep: 2,
        maxBytes: 2048,
        protectedVersions: ["tools-1"],
      });

      const retained = fs
        .readdirSync(toolsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      expect(retained).toEqual(["tools-1", "tools-4", "tools-5"]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves referenced project bundle versions when pruning", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
      closeDatabase();
      const bundlesRoot = path.join(base, "project-bundles");
      fs.mkdirSync(bundlesRoot, { recursive: true });
      for (const version of [
        "bundle-1",
        "bundle-2",
        "bundle-3",
        "bundle-4",
        "bundle-5",
      ]) {
        const dir = path.join(bundlesRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "README.txt"), `${version}\n`);
      }
      upsertProject({
        project_id: "project-1",
        state: "running",
        project_bundle_version: "bundle-2",
      });
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "bundle-5"), currentLink);
      const versionDir = path.join(bundlesRoot, "bundle-6");
      await __test__.downloadAndInstall({
        artifact: "project-bundle",
        canonicalArtifact: "project",
        version: "bundle-6",
        url: served.url,
        stripComponents: 1,
        root: bundlesRoot,
        versionDir,
        currentLink,
      } as any);

      const versions = fs
        .readdirSync(bundlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "current")
        .map((entry) => entry.name)
        .sort();
      expect(versions).toEqual(["bundle-2", "bundle-5", "bundle-6"]);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("preserves host-agent rollback versions for project-host pruning", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      fs.mkdirSync(process.env.COCALC_DATA, { recursive: true });
      fs.writeFileSync(
        path.join(process.env.COCALC_DATA, "host-agent-state.json"),
        JSON.stringify(
          {
            project_host: {
              last_known_good_version: "v02",
              pending_rollout: {
                target_version: "v13",
                previous_version: "v03",
                started_at: "2026-04-19T00:00:00.000Z",
                deadline_at: "2026-04-19T00:10:00.000Z",
              },
            },
          },
          null,
          2,
        ),
      );
      const bundlesRoot = path.join(base, "project-host-bundles");
      fs.mkdirSync(bundlesRoot, { recursive: true });
      for (const version of [
        "v01",
        "v02",
        "v03",
        "v04",
        "v05",
        "v06",
        "v07",
        "v08",
        "v09",
        "v10",
        "v11",
        "v12",
      ]) {
        const dir = path.join(bundlesRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "README.txt"), `${version}\n`);
      }
      const currentLink = path.join(bundlesRoot, "current");
      fs.symlinkSync(path.join(bundlesRoot, "v12"), currentLink);
      const versionDir = path.join(bundlesRoot, "v13");
      await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v13",
        url: served.url,
        stripComponents: 1,
        root: bundlesRoot,
        versionDir,
        currentLink,
      } as any);

      const versions = fs
        .readdirSync(bundlesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== "current")
        .map((entry) => entry.name)
        .sort();
      expect(versions).toEqual([
        "v02",
        "v03",
        "v06",
        "v07",
        "v08",
        "v09",
        "v10",
        "v11",
        "v12",
        "v13",
      ]);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
