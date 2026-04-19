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
});
