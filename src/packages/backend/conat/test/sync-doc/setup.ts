import {
  before as before0,
  after as after0,
  client as client0,
  wait,
} from "@cocalc/backend/conat/test/setup";
export { connect, wait, once, delay } from "@cocalc/backend/conat/test/setup";
import {
  createPathFileserver,
  cleanupFileservers,
} from "@cocalc/backend/conat/files/test/util";
export { uuid } from "@cocalc/util/misc";

export { client0 as client };

export let server, fs;

const CLEANUP_DISCONNECT_RE =
  /socket has been disconnected|socket is disconnected|once: .* not emitted before "closed"|connection closed/i;

function isExpectedCleanupDisconnect(err: unknown): boolean {
  return CLEANUP_DISCONNECT_RE.test(`${err ?? ""}`);
}

async function withSuppressedCleanupDisconnects(fn: () => Promise<void>) {
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
    try {
      await fn();
    } catch (err) {
      if (!isExpectedCleanupDisconnect(err)) {
        throw err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
  }
}

export async function before() {
  await before0();
  server = await createPathFileserver({ unsafeMode: true });
}

export async function after() {
  await withSuppressedCleanupDisconnects(async () => {
    try {
      await require("@cocalc/sync/editor/generic/sync-doc").SyncDoc.closeAllForTests?.();
    } catch {}
    try {
      require("@cocalc/backend/sandbox/sync-fs-service").cleanupSyncFsServicesForTests?.();
    } catch {}
    await cleanupFileservers();
    await after0();
  });
}

// wait until the state of several syncdocs all have same heads- they may have multiple
// heads, but they all have the same heads
export async function waitUntilSynced(syncdocs: any[]) {
  await wait({
    until: () => {
      const X = new Set<string>();
      try {
        for (const s of syncdocs) {
          const heads = s.getHeads?.() ?? [];
          X.add(JSON.stringify([...heads].sort()));
          if (X.size > 1) {
            return false;
          }
        }
        return true;
      } catch (err) {
        console.log(err);
        return false;
      }
    },
  });
}
