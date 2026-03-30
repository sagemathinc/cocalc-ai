import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "@jest/globals";

import { __test__ } from "./upgrade";

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
});
