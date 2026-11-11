/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// BunPty (./pty.ts) runs only under Bun: these tests run it with bun, when
// bun is installed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PTY = join(__dirname, "pty.ts");
const hasBun =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const maybe = hasBun ? describe : describe.skip;

// Runs `body` under bun with BunPty and a helper `run(file, args, opts)` that
// resolves to { pty, data, exit, events }; prints the JSON the body returns.
// The process must end on its own: a terminal left open keeps it alive.
function underBun(body: string): any {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-bunpty-"));
  try {
    const script = `
      const { BunPty, EOF_WAIT_MS } = require(${JSON.stringify(PTY)});
      function run(file, args, opts = {}) {
        const pty = new BunPty(file, args, { cols: 80, rows: 24, ...opts });
        const events = [];
        let data = "";
        pty.on("data", (d) => { data += d; events.push("data"); });
        const exit = new Promise((resolve) => pty.on("exit", (exitCode, signal) => {
          events.push("exit");
          resolve({ exitCode, signal, at: Date.now() });
        }));
        return { pty, events, get data() { return data; }, exit };
      }
      (async () => {
        const result = await (async () => { ${body} })();
        console.log(JSON.stringify(result));
      })();
    `;
    // (from the temp directory: no tsconfig.json for bun to read)
    const r = spawnSync("bun", ["-e", script], {
      encoding: "utf8",
      cwd: dir,
      timeout: 20_000,
    });
    if (r.error || r.status !== 0) {
      throw new Error(
        `bun ${r.error ? r.error.message : `exited ${r.status} ${r.signal ?? ""}`}: ${r.stderr}`,
      );
    }
    const lines = r.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

maybe("BunPty (under Bun)", () => {
  it("closes the terminal when the process exits, so nothing stays open", () => {
    const result = underBun(`
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(run("sh", ["-c", "printf hello" + i]));
      const exits = await Promise.all(runs.map((r) => r.exit));
      return {
        data: runs.map((r) => r.data),
        exitCodes: exits.map((e) => e.exitCode),
        closed: runs.map((r) => r.pty.terminal.closed),
      };
    `);
    // (underBun also checks that bun ended by itself)
    expect(result).toEqual({
      data: ["hello0", "hello1", "hello2", "hello3", "hello4"],
      exitCodes: [0, 0, 0, 0, 0],
      closed: [true, true, true, true, true],
    });
  });

  it("delivers all of the output before the exit", () => {
    const result = underBun(`
      const r = run("sh", ["-c", "seq 1 100000; printf END"]);
      const exit = await r.exit;
      return {
        lines: r.data.split("\\r\\n").length,
        end: r.data.endsWith("100000\\r\\nEND"),
        lastEvent: r.events[r.events.length - 1],
        exitCode: exit.exitCode,
      };
    `);
    expect(result).toEqual({
      lines: 100001,
      end: true,
      lastEvent: "exit",
      exitCode: 0,
    });
  });

  it("holds the exit back until output paused before it is delivered", () => {
    const result = underBun(`
      const r = run("sh", ["-c", "sleep 0.2; printf late"]);
      r.pty.pause();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const whilePaused = [...r.events];
      r.pty.resume();
      const exit = await r.exit;
      return { whilePaused, events: r.events, data: r.data, closed: r.pty.terminal.closed, exitCode: exit.exitCode };
    `);
    expect(result).toEqual({
      whilePaused: [],
      events: ["data", "exit"],
      data: "late",
      closed: true,
      exitCode: 0,
    });
  });

  it("exits promptly when a background job inherits the terminal", () => {
    const result = underBun(`
      const start = Date.now();
      // sleep inherits the terminal (the shell exiting hangs it up)
      const r = run("sh", ["-c", "sleep 5 & printf x"]);
      const exit = await r.exit;
      return { data: r.data, ms: exit.at - start, max: EOF_WAIT_MS + 1500, closed: r.pty.terminal.closed };
    `);
    expect(result.data).toBe("x");
    expect(result.closed).toBe(true);
    expect(result.ms).toBeLessThan(result.max);
  });

  it("reports the exit code, and kill", () => {
    const result = underBun(`
      const a = run("sh", ["-c", "exit 3"]);
      const b = run("sleep", ["10"]);
      setTimeout(() => b.pty.kill("SIGTERM"), 200);
      const [ea, eb] = await Promise.all([a.exit, b.exit]);
      return { a: ea.exitCode, bSignal: eb.signal };
    `);
    expect(result).toEqual({ a: 3, bSignal: 15 });
  });
});
