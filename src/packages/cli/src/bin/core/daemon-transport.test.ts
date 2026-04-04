import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  currentDaemonFingerprint,
  daemonFingerprintMatches,
} from "./daemon-transport";

test("currentDaemonFingerprint tracks the CLI script path and mtime", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cocalc-cli-daemon-"));
  const script = path.join(dir, "cocalc.js");
  writeFileSync(script, "console.log('v1');\n");
  const first = currentDaemonFingerprint(["node", script], "/usr/bin/node");
  writeFileSync(script, "console.log('v2');\n");
  const second = currentDaemonFingerprint(["node", script], "/usr/bin/node");
  assert.notEqual(first, second);
});

test("daemonFingerprintMatches requires an exact fingerprint match", () => {
  assert.equal(daemonFingerprintMatches("a", "a"), true);
  assert.equal(daemonFingerprintMatches("a", "b"), false);
  assert.equal(daemonFingerprintMatches("a", null), false);
  assert.equal(daemonFingerprintMatches("a", undefined), false);
});
