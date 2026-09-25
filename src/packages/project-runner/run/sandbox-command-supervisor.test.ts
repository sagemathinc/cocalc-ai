import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { SANDBOX_COMMAND_SUPERVISOR } from "./sandbox-command-supervisor";

test.each(["closed", "expired"])(
  "a %s command lease kills the shell and its sleeping child",
  async (mode) => {
    const child = spawn(
      process.execPath,
      ["-e", SANDBOX_COMMAND_SUPERVISOR, "--", 'sleep 60 & echo "$!"; wait'],
      { stdio: "pipe" },
    );
    const exited = once(child, "exit");
    try {
      const [chunk] = await once(child.stdout, "data");
      const pid = Number(chunk.toString().trim());
      expect(pid).toBeGreaterThan(1);
      if (mode === "closed") child.stdin.end();
      expect((await exited)[0]).toBe(130);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      expect(
        stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
      ).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  },
  15000,
);
