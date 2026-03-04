// test/setup.js

// checked for in some code to behave differently while running unit tests.
process.env.COCALC_TEST_MODE = true;

// openat2 support is Linux-only. On macOS/other platforms we explicitly allow
// the node fallback path during tests.
if (process.platform !== "linux") {
  process.env.COCALC_SANDBOX_OPENAT2 = "off";
}
