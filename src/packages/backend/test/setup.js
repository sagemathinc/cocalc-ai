// test/setup.js

// checked for in some code to behave differently while running unit tests.
process.env.COCALC_TEST_MODE = true;

// the durability records of disk-backed persist streams (finding 028): a
// directory of this test process, never the host's /run/cocalc-persist
if (!process.env.COCALC_PERSIST_RUN_DIR) {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  process.env.COCALC_PERSIST_RUN_DIR = mkdtempSync(
    join(tmpdir(), "cocalc-persist-run-"),
  );
}
// and its durable post-reboot records (028 B-2): also this test process's
if (!process.env.COCALC_PERSIST_STATE_DIR) {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  process.env.COCALC_PERSIST_STATE_DIR = mkdtempSync(
    join(tmpdir(), "cocalc-persist-state-"),
  );
}

// the data dir (backend/data.ts: COCALC_DATA_DIR ?? DATA ?? {root}/data) and
// the persist streams' sync root (syncFiles.local = COCALC_SYNC ?? {data}/sync):
// this test process's own, never a developer's live {root}/data -- the persist
// and maintenance tests create their databases there (ops0 3707, SA 3420).
// Here in setupFiles, before any test file imports @cocalc/backend/data
// (which computes them at module load).
if (!process.env.COCALC_DATA_DIR && !process.env.DATA) {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  process.env.COCALC_DATA_DIR = mkdtempSync(join(tmpdir(), "cocalc-data-"));
}
if (!process.env.COCALC_SYNC) {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  process.env.COCALC_SYNC = mkdtempSync(join(tmpdir(), "cocalc-sync-"));
}

// openat2 support is Linux-only. On macOS/other platforms we explicitly allow
// the node fallback path during tests.
if (process.platform !== "linux") {
  process.env.COCALC_SANDBOX_OPENAT2 = "off";
}
