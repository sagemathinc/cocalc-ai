import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import {
  fetchProjectDevToolsVersion,
  MAX_PROBE_RESPONSE_BYTES,
} from "./browser";

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
