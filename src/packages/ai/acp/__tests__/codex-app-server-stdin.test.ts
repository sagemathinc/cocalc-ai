/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A project stop closes the app-server's stdin while the launcher still
// runs. The next write fails with EPIPE; it must fail that client only, not
// crash the shared ACP worker with an unhandled 'error' event.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { AppServerClient } from "../codex-app-server";

describe("codex app-server stdin closed under the client", () => {
  it("turns EPIPE into errors for this client instead of crashing", async () => {
    // Closes its stdin (the pipe's only reader), then keeps running.
    const proc = spawn("sh", ["-c", "exec 0<&-; sleep 30"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const client = new AppServerClient(proc);
      // The client's own listener is what keeps the worker alive; the test's
      // once() below would otherwise hide a missing one.
      expect(proc.stdin!.listenerCount("error")).toBeGreaterThan(0);
      const broken = once(proc.stdin!, "error");
      // Give the child time to close its stdin, then write into it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      client.notify("initialized", {});
      const [err] = await broken;
      expect(`${err}`).toMatch(/EPIPE/);
      expect(() => client.notify("initialized", {})).toThrow(/stdin is closed/);
      await expect(client.request("thread/start", {}, 5_000)).rejects.toThrow(
        /stdin is closed/,
      );
    } finally {
      proc.kill("SIGKILL");
    }
  });
});
