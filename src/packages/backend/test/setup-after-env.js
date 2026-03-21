const CLEANUP_DISCONNECT_RE =
  /socket has been disconnected|socket is disconnected|once: .* not emitted before "closed"|connection closed/i;

function isExpectedCleanupDisconnect(err) {
  return CLEANUP_DISCONNECT_RE.test(`${err ?? ""}`);
}

async function withSuppressedCleanupDisconnects(fn) {
  const onUnhandledRejection = (reason) => {
    if (isExpectedCleanupDisconnect(reason)) {
      return;
    }
    throw reason;
  };
  const onUncaughtException = (err) => {
    if (isExpectedCleanupDisconnect(err)) {
      return;
    }
    throw err;
  };
  process.prependListener("unhandledRejection", onUnhandledRejection);
  process.prependListener("uncaughtException", onUncaughtException);
  try {
    await fn();
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
  }
}

async function cleanupOnce() {
  try {
    await require("../../sync/editor/generic/sync-doc").SyncDoc.closeAllForTests?.();
  } catch {
    // best-effort cleanup only
  }
  try {
    require("../sandbox/sync-fs-service").cleanupSyncFsServicesForTests?.();
  } catch {
    // best-effort cleanup only
  }
  try {
    await require("@cocalc/conat/project/jupyter/live-run").closeAllLiveRunStoresForTests?.();
  } catch {
    // best-effort cleanup only
  }
  try {
    require("@cocalc/conat/core/client").Client.closeAllForTests?.();
  } catch {
    // best-effort cleanup only
  }
  try {
    require("@cocalc/conat/client").closeConatClientForTests?.();
  } catch {
    // best-effort cleanup only
  }
  try {
    await require("@cocalc/conat/core/server").ConatServer.closeAllForTests?.();
  } catch {
    // best-effort cleanup only
  }
}

afterAll(async () => {
  const testPath = expect.getState?.().testPath ?? "";
  if (testPath.includes("/conat/test/")) {
    return;
  }
  await withSuppressedCleanupDisconnects(async () => {
    await cleanupOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupOnce();
  });
});
