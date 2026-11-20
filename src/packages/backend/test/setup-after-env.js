// finding 028 (AS-B2-SYNC-OWNER): a production open registers its owner through
// the persist server (prepareDurableOpen); a test that constructs a disk
// stream directly counts as "host" (no project scope).  The refusal's own
// tests unset it.
require("@cocalc/conat/persist/context").setUnregisteredStreamOwnerForTests(
  () => "host",
);

// finding 028: in the persist, sync and core suites, every disk-stream
// connection runs under the statement guard (conat/persist/test-durability):
// a write outside a transaction throws, so the whole suite passing shows there
// is no unarmed autocommit.  Their start-up check is the test-only one with
// a lower NOFILE minimum (ops0's NOFILE ruling, 11-18: test/persist-nofile-hook).
{
  const testPath = expect.getState().testPath ?? "";
  if (/\/conat\/(test\/(persist|sync|sync-doc|core)\/|persist-)/.test(testPath)) {
    const persist = require("../conat/persist");
    const { persistContextOptions } = persist;
    // the write counter's own tests run raw autocommits on purpose, to test
    // the counter
    const guarded = !testPath.endsWith("/write-rate.test.ts");
    const {
      guardedWriteCounter,
    } = require("@cocalc/conat/persist/test-durability");
    require("./persist-nofile-hook").installTestPersistStartupCheck({
      persist,
      durability: require("../conat/persist-durability"),
      context: require("@cocalc/conat/persist/context"),
      extra: guarded
        ? {
            writeCounter: guardedWriteCounter(
              persistContextOptions.writeCounter,
              persistContextOptions.durability,
            ),
          }
        : {},
    });
  }
}

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
    await require("../sandbox/watch").cleanupSandboxWatchersForTests?.();
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
  await withSuppressedCleanupDisconnects(async () => {
    await cleanupOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanupOnce();
  });
});
