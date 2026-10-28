// Runs a jest-style test file (describe/test, node:assert) under node:test, for
// the pure-JS ZMTP tests on machines without the workspace's jest install
// (.github/workflows/jupyter-zmtp-windows.yml):
//   node --test-reporter=spec node-test-shim.cjs <compiled test file>
const t = require("node:test");
global.describe = t.describe;
global.test = t.test;
require(require("node:path").resolve(process.argv[2]));
