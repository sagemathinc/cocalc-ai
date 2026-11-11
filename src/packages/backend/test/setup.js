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

// openat2 support is Linux-only. On macOS/other platforms we explicitly allow
// the node fallback path during tests.
if (process.platform !== "linux") {
  process.env.COCALC_SANDBOX_OPENAT2 = "off";
}
