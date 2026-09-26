import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  currentDaemonFingerprint,
  daemonFingerprintMatches,
  daemonLogPath,
  daemonPidPath,
  daemonSpawnTarget,
  daemonSocketPath,
  ensurePrivateDaemonRuntimeDir,
} from "./daemon-transport";

test("currentDaemonFingerprint tracks the CLI script path and mtime", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cocalc-cli-daemon-"));
  const script = path.join(dir, "cocalc.js");
  writeFileSync(script, "console.log('v1');\n");
  const first = currentDaemonFingerprint(["node", script], "/usr/bin/node");
  const initialMtimeMs = statSync(script).mtimeMs;
  writeFileSync(script, "console.log('v2');\n");
  const updatedMtime = new Date(initialMtimeMs + 1000);
  utimesSync(script, updatedMtime, updatedMtime);
  const second = currentDaemonFingerprint(["node", script], "/usr/bin/node");
  assert.notEqual(first, second);
});

test("daemonFingerprintMatches requires an exact fingerprint match", () => {
  assert.equal(daemonFingerprintMatches("a", "a"), true);
  assert.equal(daemonFingerprintMatches("a", "b"), false);
  assert.equal(daemonFingerprintMatches("a", null), false);
  assert.equal(daemonFingerprintMatches("a", undefined), false);
});

test("daemon reuse requires matching local transport, project admission and profile configuration", () => {
  const fingerprint = (env: NodeJS.ProcessEnv) =>
    currentDaemonFingerprint([], "/nonexistent-node-for-test", env);
  const initial = fingerprint({});
  for (const key of [
    "CONAT_SERVER",
    "COCALC_API_RELAY",
    "COCALC_API_RELAY_HUB_URL",
    "COCALC_SITE_URL",
    "COCALC_PROJECT_ID",
    "COCALC_PROJECT_SECRET",
    "COCALC_SECRET_TOKEN",
    "COCALC_CLI_CONFIG",
    "HOME",
    "XDG_CONFIG_HOME",
  ]) {
    const changed = fingerprint({ [key]: "new-sensitive-configuration" });
    assert.notEqual(changed, initial, key);
    assert.equal(changed.includes("new-sensitive-configuration"), false);
  }
  assert.equal(
    fingerprint({ COCALC_API_RELAY: "1", CONAT_SERVER: "http://local" }),
    fingerprint({ CONAT_SERVER: "http://local", COCALC_API_RELAY: "1" }),
  );
  assert.equal(
    fingerprint({
      COCALC_CLI_DAEMON_MODE: "1",
      COCALC_CODEX_MESSAGE_DATE: "later",
    }),
    initial,
  );
});

test("ensurePrivateDaemonRuntimeDir creates a private runtime directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cocalc-cli-daemon-"));
  const socket = path.join(dir, "runtime", "cli-daemon.sock");
  ensurePrivateDaemonRuntimeDir(socket);
  assert.equal(statSync(path.dirname(socket)).mode & 0o777, 0o700);
});

test("uses a stable per-user Windows named pipe and native state paths", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\Ada Lovelace\\AppData\\Local",
    USERDOMAIN: "EXAMPLE",
    USERNAME: "ada",
  } as NodeJS.ProcessEnv;
  const socket = daemonSocketPath(env, "win32");
  assert.match(socket, /^\\\\\.\\pipe\\cocalc-cli-[a-f0-9]{16}$/);
  assert.equal(socket, daemonSocketPath(env, "win32"));
  assert.match(
    daemonPidPath(env, "win32"),
    /^C:\\Users\\Ada Lovelace\\AppData\\Local\\CoCalc\\CLI\\cache\\runtime\\cli-daemon-[a-f0-9]{16}\.pid$/,
  );
  assert.match(
    daemonLogPath(env, "win32"),
    /^C:\\Users\\Ada Lovelace\\AppData\\Local\\CoCalc\\CLI\\cache\\runtime\\cli-daemon-[a-f0-9]{16}\.log$/,
  );
});

test("standalone daemon self-reexecution does not pass the executable as a script", () => {
  assert.deepEqual(
    daemonSpawnTarget({
      argv: ["C:\\CoCalc\\cocalc.exe", "C:\\CoCalc\\cocalc.exe"],
      execPath: "C:\\CoCalc\\cocalc.exe",
      sea: true,
    }),
    { cmd: "C:\\CoCalc\\cocalc.exe", args: [] },
  );
});
