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

function createContainerRuntimeArchive(
  base: string,
  failStateProbe = false,
  pasta?: { version: string; reports: string },
): string {
  const sourceRoot = path.join(base, "runtime-archive-root");
  const payloadDir = path.join(sourceRoot, "container-runtime");
  const binDir = path.join(payloadDir, "bin");
  const metadataDir = path.join(payloadDir, "share", "cocalc");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(metadataDir, { recursive: true });
  const podmanPath = path.join(binDir, "podman");
  fs.writeFileSync(
    podmanPath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "podman version test"
  exit 0
fi
case "$*" in
  *DatabaseBackend*) echo sqlite; exit 0 ;;
  *NetworkBackend*) echo netavark; exit 0 ;;
  *CgroupManager*) echo cgroupfs; exit 0 ;;
esac
exit ${failStateProbe ? 1 : 0}
`,
  );
  for (const binary of ["conmon", "crun", "netavark", "aardvark-dns"]) {
    fs.copyFileSync("/usr/bin/true", path.join(binDir, binary));
  }
  for (const binary of [
    "podman",
    "conmon",
    "crun",
    "netavark",
    "aardvark-dns",
  ]) {
    fs.chmodSync(path.join(binDir, binary), 0o755);
  }
  if (pasta) {
    const pastaPath = path.join(binDir, "pasta");
    fs.writeFileSync(pastaPath, `#!/bin/sh\necho "pasta ${pasta.reports}"\n`);
    fs.chmodSync(pastaPath, 0o755);
  }
  const versionOutput = execFileSync(podmanPath, ["--version"], {
    encoding: "utf8",
  }).trim();
  fs.writeFileSync(
    path.join(metadataDir, "runtime-manifest.json"),
    JSON.stringify({
      schema: "cocalc-container-runtime-v1",
      components: {
        podman: { version: versionOutput },
        ...(pasta ? { passt: { version: pasta.version } } : {}),
      },
      host_contract: {
        database_backend: "sqlite",
        network_backend: "netavark",
        cgroup_manager: "cgroupfs",
        required_commands: [],
      },
    }),
  );
  const archivePath = path.join(base, "container-runtime.tar.xz");
  execFileSync("tar", [
    "-cJf",
    archivePath,
    "-C",
    sourceRoot,
    "container-runtime",
  ]);
  return archivePath;
}

function installFakeExistingPodman(
  current: string,
  { running = false }: { running?: boolean } = {},
): void {
  const versionDir = path.join(path.dirname(current), "old");
  const binDir = path.join(versionDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const podman = path.join(binDir, "podman");
  const runningMarker = path.join(versionDir, "running");
  if (running) fs.writeFileSync(runningMarker, "running\n");
  fs.writeFileSync(
    podman,
    `#!/bin/sh
case "$*" in
  *DatabaseBackend*) echo sqlite ;;
  *NetworkBackend*) echo cni ;;
  *CgroupManager*) echo cgroupfs ;;
  "ps -q") test -f ${JSON.stringify(runningMarker)} && echo running-container ;;
  "stop --all --time 5") rm -f ${JSON.stringify(runningMarker)} ;;
esac
exit 0
`,
  );
  fs.chmodSync(podman, 0o755);
  fs.symlinkSync(versionDir, current);
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
  delete process.env.COCALC_PROJECT_HOST_UPGRADE_FETCH_TIMEOUT_MS;
  delete process.env.COCALC_PROJECT_HOST_UPGRADE_DOWNLOAD_TIMEOUT_MS;
  delete process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_RUNTIME_ARTIFACT_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PROJECT_BUNDLE_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_BUNDLE_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PROJECT_TOOLS_RETENTION_COUNT;
  delete process.env.COCALC_PROJECT_TOOLS_RETENTION_MAX_BYTES;
  delete process.env.COCALC_CONTAINER_RUNTIME_ROOT;
  delete process.env.COCALC_CONTAINER_RUNTIME_CURRENT;
  delete process.env.COCALC_CONTAINER_RUNTIME_RETENTION_COUNT;
  delete process.env.COCALC_CONTAINER_RUNTIME_RETENTION_MAX_BYTES;
  delete process.env.COCALC_PODMAN_RUNTIME_DIR;
  closeDatabase();
});

describe("project host upgrade installer", () => {
  it("schedules an explicit project-host restart after returning the RPC response", () => {
    expect(
      __test__.scheduledProjectHostReconcileCommand(
        "/opt/cocalc/project-host/current/cocalc-project-host",
      ),
    ).toBe(
      "sleep 3; COCALC_PROJECT_HOST_RELOAD_ENV_FILES=1 /opt/cocalc/project-host/current/cocalc-project-host daemon restart-project-host || true",
    );
  });

  it("caps curl fallback timeouts for host upgrades", () => {
    expect(__test__.curlTimeoutArgs(500)).toEqual([
      "--connect-timeout",
      "1",
      "--max-time",
      "1",
    ]);
    expect(__test__.curlTimeoutArgs(125_000)).toEqual([
      "--connect-timeout",
      "20",
      "--max-time",
      "125",
    ]);
  });

  it("times out long-running fallback commands", async () => {
    await expect(
      __test__.runCommandCapture("bash", ["-lc", "sleep 5"], { timeoutMs: 50 }),
    ).rejects.toThrow("timed out after 50ms");
  });

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

  it("serializes concurrent installs targeting the same current link", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    const archivePath = createArchive(base);
    const served = await serveFile(archivePath);
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const root = path.join(base, "project-host-bundles");
      const versionDir = path.join(root, "v1");
      const currentLink = path.join(root, "current");
      const resolved = {
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v1",
        url: served.url,
        stripComponents: 1,
        root,
        versionDir,
        currentLink,
      } as any;

      const results = await Promise.all([
        __test__.downloadAndInstall(resolved),
        __test__.downloadAndInstall(resolved),
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual([
        "noop",
        "updated",
      ]);
      expect(fs.realpathSync(currentLink)).toBe(versionDir);
      expect(fs.readFileSync(path.join(versionDir, "README.txt"), "utf8")).toBe(
        "project-host bundle\n",
      );
      expect(
        fs.readdirSync(root).filter((name) => name.includes(".extract-")),
      ).toEqual([]);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("reuses an existing immutable artifact version without replacing it", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const root = path.join(base, "project-host-bundles");
      const oldDir = path.join(root, "v0");
      const versionDir = path.join(root, "v1");
      const currentLink = path.join(root, "current");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "README.txt"), "old\n");
      fs.writeFileSync(path.join(versionDir, "README.txt"), "existing\n");
      fs.symlinkSync(oldDir, currentLink);
      const inode = fs.statSync(versionDir).ino;

      const result = await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v1",
        url: "http://127.0.0.1:1/must-not-download.tar.xz",
        stripComponents: 1,
        root,
        versionDir,
        currentLink,
      } as any);

      expect(result).toEqual({
        artifact: "project-host",
        version: "v1",
        status: "updated",
      });
      expect(fs.realpathSync(currentLink)).toBe(versionDir);
      expect(fs.statSync(versionDir).ino).toBe(inode);
      expect(fs.readFileSync(path.join(versionDir, "README.txt"), "utf8")).toBe(
        "existing\n",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("stages an immutable project-host artifact without changing current", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      const root = path.join(base, "project-host-bundles");
      const oldDir = path.join(root, "v0");
      const versionDir = path.join(root, "v1");
      const currentLink = path.join(root, "current");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "README.txt"), "old\n");
      fs.writeFileSync(path.join(versionDir, "README.txt"), "staged\n");
      fs.symlinkSync(oldDir, currentLink);

      const result = await __test__.downloadAndInstall({
        artifact: "project-host",
        canonicalArtifact: "project-host",
        version: "v1",
        url: "http://127.0.0.1:1/must-not-download.tar.xz",
        stripComponents: 1,
        root,
        versionDir,
        currentLink,
        activate: false,
      } as any);

      expect(result).toEqual({
        artifact: "project-host",
        version: "v1",
        status: "staged",
      });
      expect(fs.realpathSync(currentLink)).toBe(oldDir);
      expect(fs.readFileSync(path.join(versionDir, "README.txt"), "utf8")).toBe(
        "staged\n",
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails closed instead of replacing an empty immutable artifact version", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      process.env.COCALC_DATA = path.join(base, "data");
      const root = path.join(base, "project-host-bundles");
      const oldDir = path.join(root, "v0");
      const versionDir = path.join(root, "v1");
      const currentLink = path.join(root, "current");
      fs.mkdirSync(oldDir, { recursive: true });
      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, "README.txt"), "old\n");
      fs.symlinkSync(oldDir, currentLink);

      await expect(
        __test__.downloadAndInstall({
          artifact: "project-host",
          canonicalArtifact: "project-host",
          version: "v1",
          url: "http://127.0.0.1:1/must-not-download.tar.xz",
          stripComponents: 1,
          root,
          versionDir,
          currentLink,
        } as any),
      ).rejects.toThrow("refusing to replace empty immutable artifact version");
      expect(fs.realpathSync(currentLink)).toBe(oldDir);
      expect(fs.readdirSync(versionDir)).toEqual([]);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("activates a validated container runtime against existing sqlite state", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-runtime-test-"));
    const archivePath = createContainerRuntimeArchive(base);
    const served = await serveFile(archivePath);
    try {
      const runtimeRoot = path.join(base, "container-runtime");
      const currentLink = path.join(runtimeRoot, "current");
      const runtimeDir = path.join(base, "run");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.mkdirSync(runtimeDir);
      installFakeExistingPodman(currentLink);
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_CONTAINER_RUNTIME_ROOT = runtimeRoot;
      process.env.COCALC_CONTAINER_RUNTIME_CURRENT = currentLink;
      process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;

      const result = await __test__.downloadAndInstall({
        artifact: "container-runtime",
        canonicalArtifact: "container-runtime",
        version: "5.8.2",
        url: served.url,
        stripComponents: 1,
        root: runtimeRoot,
        versionDir: path.join(runtimeRoot, "5.8.2"),
        currentLink,
      } as any);

      expect(result).toEqual({
        artifact: "container-runtime",
        version: "5.8.2",
        status: "updated",
      });
      expect(fs.realpathSync(currentLink)).toBe(
        path.join(runtimeRoot, "5.8.2"),
      );
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("rolls back a container runtime that cannot read existing state", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-runtime-test-"));
    const archivePath = createContainerRuntimeArchive(base, true);
    const served = await serveFile(archivePath);
    try {
      const runtimeRoot = path.join(base, "container-runtime");
      const currentLink = path.join(runtimeRoot, "current");
      const runtimeDir = path.join(base, "run");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.mkdirSync(runtimeDir);
      installFakeExistingPodman(currentLink);
      const previousTarget = fs.realpathSync(currentLink);
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_CONTAINER_RUNTIME_ROOT = runtimeRoot;
      process.env.COCALC_CONTAINER_RUNTIME_CURRENT = currentLink;
      process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;

      await expect(
        __test__.downloadAndInstall({
          artifact: "container-runtime",
          canonicalArtifact: "container-runtime",
          version: "broken",
          url: served.url,
          stripComponents: 1,
          root: runtimeRoot,
          versionDir: path.join(runtimeRoot, "broken"),
          currentLink,
        } as any),
      ).rejects.toThrow("was rolled back");
      expect(fs.realpathSync(currentLink)).toBe(previousTarget);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("activates a container runtime whose bundled pasta matches its manifest", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-runtime-test-"));
    const archivePath = createContainerRuntimeArchive(base, false, {
      version: "2026_10_02.cba3570",
      reports: "2026_10_02.cba3570",
    });
    const served = await serveFile(archivePath);
    try {
      const runtimeRoot = path.join(base, "container-runtime");
      const currentLink = path.join(runtimeRoot, "current");
      const runtimeDir = path.join(base, "run");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.mkdirSync(runtimeDir);
      installFakeExistingPodman(currentLink);
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_CONTAINER_RUNTIME_ROOT = runtimeRoot;
      process.env.COCALC_CONTAINER_RUNTIME_CURRENT = currentLink;
      process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;
      const versionDir = path.join(runtimeRoot, "with-pasta");

      const result = await __test__.downloadAndInstall({
        artifact: "container-runtime",
        canonicalArtifact: "container-runtime",
        version: "with-pasta",
        url: served.url,
        stripComponents: 1,
        root: runtimeRoot,
        versionDir,
        currentLink,
      } as any);

      expect(result.status).toBe("updated");
      expect(fs.realpathSync(currentLink)).toBe(versionDir);
      expect(fs.statSync(path.join(versionDir, "bin", "pasta")).isFile()).toBe(
        true,
      );
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses a container runtime whose bundled pasta reports another version", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-runtime-test-"));
    const archivePath = createContainerRuntimeArchive(base, false, {
      version: "2026_10_02.cba3570",
      reports: "0.0~git20240220.1e6f92b",
    });
    const served = await serveFile(archivePath);
    try {
      const runtimeRoot = path.join(base, "container-runtime");
      const currentLink = path.join(runtimeRoot, "current");
      const runtimeDir = path.join(base, "run");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.mkdirSync(runtimeDir);
      installFakeExistingPodman(currentLink);
      const previousTarget = fs.realpathSync(currentLink);
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_CONTAINER_RUNTIME_ROOT = runtimeRoot;
      process.env.COCALC_CONTAINER_RUNTIME_CURRENT = currentLink;
      process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;

      await expect(
        __test__.downloadAndInstall({
          artifact: "container-runtime",
          canonicalArtifact: "container-runtime",
          version: "wrong-pasta",
          url: served.url,
          stripComponents: 1,
          root: runtimeRoot,
          versionDir: path.join(runtimeRoot, "wrong-pasta"),
          currentLink,
        } as any),
      ).rejects.toThrow("pasta version mismatch");
      expect(fs.realpathSync(currentLink)).toBe(previousTarget);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("quiesces running containers before a CNI to Netavark migration", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-runtime-test-"));
    const archivePath = createContainerRuntimeArchive(base);
    const served = await serveFile(archivePath);
    try {
      const runtimeRoot = path.join(base, "container-runtime");
      const currentLink = path.join(runtimeRoot, "current");
      const runtimeDir = path.join(base, "run");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      fs.mkdirSync(runtimeDir);
      installFakeExistingPodman(currentLink, { running: true });
      process.env.COCALC_DATA = path.join(base, "data");
      process.env.COCALC_CONTAINER_RUNTIME_ROOT = runtimeRoot;
      process.env.COCALC_CONTAINER_RUNTIME_CURRENT = currentLink;
      process.env.COCALC_PODMAN_RUNTIME_DIR = runtimeDir;

      await expect(
        __test__.downloadAndInstall({
          artifact: "container-runtime",
          canonicalArtifact: "container-runtime",
          version: "5.8.2",
          url: served.url,
          stripComponents: 1,
          root: runtimeRoot,
          versionDir: path.join(runtimeRoot, "5.8.2"),
          currentLink,
        } as any),
      ).resolves.toEqual({
        artifact: "container-runtime",
        version: "5.8.2",
        status: "updated",
      });
      expect(fs.realpathSync(currentLink)).toBe(
        path.join(runtimeRoot, "5.8.2"),
      );
      expect(
        fs.existsSync(
          path.join(
            process.env.COCALC_DATA,
            "project-runtime-maintenance.json",
          ),
        ),
      ).toBe(false);
    } finally {
      await served.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

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

  it("extracts runtime artifact versions from live mountinfo, including deleted mounts", () => {
    const mountinfo = [
      "757 766 8:1 /opt/cocalc/tools/1778766667334//deleted /opt/cocalc/bin2 ro,relatime - ext4 /dev/root rw",
      "756 766 8:1 /opt/cocalc/tools/1778766667335\\040(deleted) /opt/cocalc/bin2 ro,relatime - ext4 /dev/root rw",
      "758 766 8:1 /opt/cocalc/project-bundles/1778766568480//deleted /opt/cocalc/project-bundle ro,relatime - ext4 /dev/root rw",
      "759 766 8:1 /opt/cocalc/tools/current /not-a-runtime-version ro,relatime - ext4 /dev/root rw",
      "760 766 8:1 /opt/cocalc/tools/.download /ignored ro,relatime - ext4 /dev/root rw",
    ].join("\n");

    expect(
      __test__.extractMountedArtifactVersionsFromMountinfo(
        mountinfo,
        "/opt/cocalc/tools",
      ),
    ).toEqual(["1778766667334", "1778766667335"]);
    expect(
      __test__.extractMountedArtifactVersionsFromMountinfo(
        mountinfo,
        "/opt/cocalc/project-bundles",
      ),
    ).toEqual(["1778766568480"]);
  });

  it("preserves live-mounted runtime artifact versions when sqlite references are stale", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      const toolsRoot = path.join(base, "tools");
      const procRoot = path.join(base, "proc");
      fs.mkdirSync(toolsRoot, { recursive: true });
      for (const version of ["tools-1", "tools-2", "tools-3", "tools-4"]) {
        const dir = path.join(toolsRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(1024));
      }
      const currentLink = path.join(toolsRoot, "current");
      fs.symlinkSync(path.join(toolsRoot, "tools-4"), currentLink);
      const desiredDir = path.join(toolsRoot, "tools-5");
      fs.mkdirSync(desiredDir, { recursive: true });
      fs.writeFileSync(
        path.join(desiredDir, "payload.bin"),
        Buffer.alloc(1024),
      );

      const pidDir = path.join(procRoot, "1234");
      fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(
        path.join(pidDir, "mountinfo"),
        `757 766 8:1 ${toolsRoot}/tools-1//deleted /opt/cocalc/bin2 ro,relatime - ext4 /dev/root rw\n`,
      );

      const protectedVersions = await __test__.listLiveMountedArtifactVersions(
        toolsRoot,
        procRoot,
      );
      expect(protectedVersions).toEqual(["tools-1"]);

      await __test__.pruneVersionDirs({
        root: toolsRoot,
        currentLink,
        desiredDir,
        keep: 2,
        maxBytes: 2048,
        protectedVersions,
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

  it("can protect every installed tools version while containers are running", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-upgrade-test-"));
    try {
      const toolsRoot = path.join(base, "tools");
      fs.mkdirSync(toolsRoot, { recursive: true });
      for (const version of ["tools-1", "tools-2", "tools-3", "tools-4"]) {
        const dir = path.join(toolsRoot, version);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "payload.bin"), Buffer.alloc(1024));
      }
      fs.mkdirSync(path.join(toolsRoot, ".download"));
      fs.symlinkSync(
        path.join(toolsRoot, "tools-4"),
        path.join(toolsRoot, "current"),
      );
      const protectedVersions =
        await __test__.listInstalledArtifactVersions(toolsRoot);
      expect(protectedVersions).toEqual([
        "tools-1",
        "tools-2",
        "tools-3",
        "tools-4",
      ]);

      const desiredDir = path.join(toolsRoot, "tools-5");
      fs.mkdirSync(desiredDir, { recursive: true });
      fs.writeFileSync(
        path.join(desiredDir, "payload.bin"),
        Buffer.alloc(1024),
      );
      await __test__.pruneVersionDirs({
        root: toolsRoot,
        currentLink: path.join(toolsRoot, "current"),
        desiredDir,
        keep: 1,
        protectedVersions,
      });

      const retained = fs
        .readdirSync(toolsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
      expect(retained).toEqual([
        "tools-1",
        "tools-2",
        "tools-3",
        "tools-4",
        "tools-5",
      ]);
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
