import assert from "node:assert/strict";
import { test } from "node:test";

import { spawn } from "node:child_process";

import {
  browserForwardName,
  existingBrowserForwards,
  fetchProjectDevToolsVersion,
  MAX_PROBE_RESPONSE_BYTES,
} from "./browser";

const PROJECT = "6adb0c79-a1d8-4ba3-b5cd-f0320bfedda8";

test("finds stale and live browser forwards for the same project port", () => {
  const rows = [
    { id: 1, name: browserForwardName(PROJECT, 9222, 111) }, // crashed
    { id: 2, name: browserForwardName(PROJECT, 9223, 222) }, // other port
    { id: 3, name: browserForwardName("ffffffff-0000", 9222, 333) }, // other project
    { id: 4, name: "project-6adb0c79-9222-to-9222" }, // not ours
    { id: 5, name: null },
  ];
  assert.deepEqual(
    existingBrowserForwards(rows, PROJECT, 9222, () => false),
    { stale: [1], ownerPid: null },
  );
  assert.deepEqual(
    existingBrowserForwards(rows, PROJECT, 9222, (pid) => pid === 111),
    { stale: [], ownerPid: 111 },
  );
});

test("names forwards by project, port and owning process", () => {
  assert.equal(
    browserForwardName(PROJECT, 9222, 4242),
    "cocalc-browser-6adb0c79-9222-4242",
  );
});

test("the project-port probe never buffers more than 64 KiB", async () => {
  // Stand-in for `ssh -W`: a peer that streams forever.
  const endless = () =>
    spawn(
      process.execPath,
      [
        "-e",
        "const b = Buffer.alloc(65536, 120); (function w() { process.stdout.write(b, w); })()",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
  const started = Date.now();
  const result = await fetchProjectDevToolsVersion(
    "alias",
    9222,
    new AbortController().signal,
    endless,
  );
  assert.deepEqual(result, { kind: "too-large" });
  assert.ok(Date.now() - started < 5000);
  assert.ok(MAX_PROBE_RESPONSE_BYTES <= 64 * 1024);
});

test("the probe reports nothing when the peer is silent and is abortable", async () => {
  const silent = () =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
  const abort = new AbortController();
  const pending = fetchProjectDevToolsVersion(
    "alias",
    9222,
    abort.signal,
    silent,
  );
  setTimeout(() => abort.abort(), 200);
  assert.deepEqual(await pending, { kind: "none" });
});
