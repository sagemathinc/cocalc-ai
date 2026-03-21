afterAll(async () => {
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
    await require("@cocalc/conat/core/server").ConatServer.closeAllForTests?.();
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
  await new Promise((resolve) => setTimeout(resolve, 50));
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
    await require("@cocalc/conat/core/server").ConatServer.closeAllForTests?.();
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
});
