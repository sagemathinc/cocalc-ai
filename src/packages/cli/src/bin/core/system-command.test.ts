import assert from "node:assert/strict";
import test from "node:test";

import {
  cocalcCliDataDir,
  getCloudflaredDownloadSpec,
  localCloudflaredBinaryPath,
} from "./system-command";

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
    getCloudflaredDownloadSpec({ platform: "win32", arch: "x64" }),
    undefined,
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
