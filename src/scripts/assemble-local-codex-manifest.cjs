#!/usr/bin/env node
"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

function assemble(directory) {
  const read = (platform) =>
    JSON.parse(
      readFileSync(join(directory, `manifest-linux-${platform}.json`)),
    );
  const x64 = read("x64");
  const arm64 = read("arm64");
  for (const field of [
    "version",
    "tag",
    "upstream_head",
    "patches",
    "linux_libc",
    "rust_toolchain",
  ]) {
    if (
      JSON.stringify(x64[field]) !== JSON.stringify(arm64[field]) ||
      x64[field] == null
    ) {
      throw Error(`Native build provenance differs or is missing: ${field}`);
    }
  }
  if (
    x64.linux_libc !== "musl" ||
    x64.build_platform !== "linux-x64" ||
    arm64.build_platform !== "linux-arm64"
  ) {
    throw Error("Expected separate x64 and ARM64 musl build manifests");
  }
  const binaries = {};
  const hashes = {};
  for (const [arch, prefix] of [
    ["x64", "x64"],
    ["arm64", "arm64"],
  ]) {
    for (const name of ["codex", "codex-code-mode-host"]) {
      const path = join(directory, `linux-${arch}`, name);
      const field = `${prefix}_${name === "codex" ? "binary" : "code_mode_host_binary"}`;
      binaries[field] = path;
      hashes[field] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    }
  }
  const result = {
    ...x64,
    ...binaries,
    build_platform: "all",
    host_arch: "native-per-platform",
    native_builds: { x64, arm64 },
    binary_sha256: hashes,
    built_at_utc: new Date().toISOString(),
  };
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

module.exports = { assemble };
if (require.main === module) {
  if (!process.argv[2])
    throw Error("Usage: assemble-local-codex-manifest.cjs <version-directory>");
  assemble(process.argv[2]);
}
