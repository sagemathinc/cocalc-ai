const { readdirSync, readFileSync } = require("node:fs");

const HOST_DEPENDENT_BTRFS_TESTS =
  "/btrfs/test/(?!rustic-progress\\.test\\.ts$)";

function envEnabled(name) {
  const raw = `${process.env[name] ?? ""}`.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function hasLoopbackDevices({
  platform = process.platform,
  readdirSyncImpl = readdirSync,
} = {}) {
  if (platform !== "linux") return false;
  try {
    return readdirSyncImpl("/dev").some((name) => /^loop\d+$/.test(name));
  } catch {
    return false;
  }
}

function hasBtrfsFilesystemSupport({
  platform = process.platform,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (platform !== "linux") return false;
  try {
    return readFileSyncImpl("/proc/filesystems", "utf8")
      .split("\n")
      .some((line) => line.trim().split(/\s+/).includes("btrfs"));
  } catch {
    return false;
  }
}

function shouldRunHostDependentBtrfsTests({
  platform = process.platform,
  readdirSyncImpl = readdirSync,
  readFileSyncImpl = readFileSync,
} = {}) {
  if (envEnabled("COCALC_SKIP_BTRFS_TESTS")) return false;
  if (envEnabled("COCALC_FORCE_BTRFS_TESTS")) return true;
  if (platform !== "linux") return false;
  return (
    hasLoopbackDevices({ platform, readdirSyncImpl }) &&
    hasBtrfsFilesystemSupport({ platform, readFileSyncImpl })
  );
}

module.exports = {
  HOST_DEPENDENT_BTRFS_TESTS,
  hasBtrfsFilesystemSupport,
  hasLoopbackDevices,
  shouldRunHostDependentBtrfsTests,
};
