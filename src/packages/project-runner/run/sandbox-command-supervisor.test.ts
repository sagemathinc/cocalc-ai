import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  MANAGED_SANDBOX_COMMAND_SUPERVISOR,
  SANDBOX_COMMAND_SUPERVISOR,
} from "./sandbox-command-supervisor";

test.each([undefined, "job-1-1-2-2-00000000-0000-4000-8000-000000000001"])(
  "managed prelude refuses an absent or mismatched cgroup (%s)",
  async (scope) => {
    const child = spawn(
      process.execPath,
      ["-e", MANAGED_SANDBOX_COMMAND_SUPERVISOR, "--", "printf must-not-run"],
      {
        env: { ...process.env, COCALC_MANAGED_JOB_SCOPE: scope },
        stdio: "pipe",
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    const [code] = await once(child, "close");
    expect(code).toBe(125);
    expect(output).toBe("");
  },
);

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

test.each([false, true])(
  "normal completion warns only for background leftovers (%s)",
  async (background) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        SANDBOX_COMMAND_SUPERVISOR,
        "--",
        background ? 'sleep 60 & echo "$!"' : "printf done",
      ],
      { stdio: "pipe" },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    try {
      const [code] = await once(child, "close");
      expect(code).toBe(0);
      expect(stderr.includes("use cocalc project terminal spawn")).toBe(
        background,
      );
      if (background) {
        const stat = await readFile(
          `/proc/${Number(stdout.trim())}/stat`,
          "utf8",
        ).catch(() => "");
        expect(
          stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
        ).toBe(true);
      }
    } finally {
      child.kill("SIGKILL");
    }
  },
);
