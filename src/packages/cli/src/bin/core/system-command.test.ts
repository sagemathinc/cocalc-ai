import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import {
  commandPathCandidates,
  cocalcCliDataDir,
  getCloudflaredDownloadSpec,
  localCloudflaredBinaryPath,
  ensureCloudflaredBinary,
} from "./system-command";

test(
  "cloudflared resolves to an absolute executable for non-login SSH shells",
  { skip: process.platform === "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "cloudflared path "));
    const binary = join(dir, "cloudflared");
    const saved = { ...process.env };
    try {
      writeFileSync(binary, "#!/bin/sh\nprintf working", { mode: 0o755 });
      process.env.PATH = dir;
      delete process.env.COCALC_CLI_CLOUDFLARED;
      assert.equal(await ensureCloudflaredBinary(), binary);
      const result = spawnSync(await ensureCloudflaredBinary(), [], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "working");
      process.env.COCALC_CLI_CLOUDFLARED = relative(process.cwd(), binary);
      assert.equal(await ensureCloudflaredBinary(), binary);
      process.env.COCALC_CLI_CLOUDFLARED = "missing-cloudflared";
      await assert.rejects(ensureCloudflaredBinary(), /not executable/);
    } finally {
      process.env = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("cloudflared download spec supports linux x64", () => {
  assert.deepEqual(
    getCloudflaredDownloadSpec({ platform: "linux", arch: "x64" }),
    {
      filename: "cloudflared-linux-amd64",
      kind: "binary",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    },
  );
});

test("cloudflared download spec supports linux arm64", () => {
  assert.deepEqual(
    getCloudflaredDownloadSpec({ platform: "linux", arch: "arm64" }),
    {
      filename: "cloudflared-linux-arm64",
      kind: "binary",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64",
    },
  );
});

test("cloudflared download spec supports macOS x64", () => {
  assert.deepEqual(
    getCloudflaredDownloadSpec({ platform: "darwin", arch: "x64" }),
    {
      filename: "cloudflared-darwin-amd64.tgz",
      kind: "tgz",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
    },
  );
});

test("cloudflared download spec supports macOS arm64", () => {
  assert.deepEqual(
    getCloudflaredDownloadSpec({ platform: "darwin", arch: "arm64" }),
    {
      filename: "cloudflared-darwin-arm64.tgz",
      kind: "tgz",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz",
    },
  );
});

test("cloudflared download spec rejects unsupported platforms", () => {
  assert.equal(
    getCloudflaredDownloadSpec({ platform: "freebsd", arch: "x64" }),
    undefined,
  );
});

test("cloudflared download spec supports Windows x64", () => {
  assert.deepEqual(
    getCloudflaredDownloadSpec({ platform: "win32", arch: "x64" }),
    {
      filename: "cloudflared-windows-amd64.exe",
      kind: "binary",
      url: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    },
  );
});

test("builds Windows command candidates with PATH and PATHEXT", () => {
  assert.deepEqual(
    commandPathCandidates("ssh", {
      env: { PATH: "C:\\Tools", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
    }),
    ["C:\\Tools\\ssh.EXE", "C:\\Tools\\ssh.CMD"],
  );
});

test("cloudflared local path uses CLI data dir", () => {
  assert.equal(
    cocalcCliDataDir({ XDG_DATA_HOME: "/tmp/xdg-data" } as any),
    "/tmp/xdg-data/cocalc",
  );
  assert.equal(
    cocalcCliDataDir({ COCALC_CLI_DATA_DIR: "/tmp/cocalc-data" } as any),
    "/tmp/cocalc-data",
  );
  assert.equal(
    localCloudflaredBinaryPath("/tmp/cocalc-data"),
    "/tmp/cocalc-data/bin/cloudflared",
  );
});
