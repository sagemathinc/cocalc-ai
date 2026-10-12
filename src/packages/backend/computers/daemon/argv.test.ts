/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// An argv reaches the command exactly, whatever the user's login shell:
// fish reads backslashes inside single quotes differently from sh, so the
// login shell must never parse the arguments itself.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runExec } from "./exec";
import { JobManager } from "./jobs";

const SHELLS = [
  "/bin/sh",
  "/bin/bash",
  "/usr/bin/zsh",
  "/bin/zsh",
  "/usr/bin/fish",
  "/opt/homebrew/bin/fish",
  "/usr/bin/dash",
].filter(existsSync);

const ARGS = [
  "a\\\\b", // two backslashes
  "x\\'y", // a backslash before an apostrophe
  "it's",
  "\\",
  "'",
  "$HOME",
  "*",
  "~",
  "line\nbreak",
  "!x",
  '"dq"',
  "`id`",
  "$(id)",
  "a b",
  "",
  "ünï ✓",
  "-n",
];
const ARGV = ["printf", "%s|", ...ARGS];
const WANT = ARGS.map((a) => `${a}|`).join("");

describe("argv runs exactly in every login shell", () => {
  let dir: string;
  let work: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "computer-argv-"));
    work = join(dir, "work");
    mkdirSync(work);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("has at least sh and bash to test with", () => {
    expect(SHELLS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SHELLS)("exec, login shell %s", async (shell) => {
    const r = await runExec(
      { command: null, argv: ARGV, cwd: null, timeout_ms: 10_000, stdin: null },
      { workdir: work, logDir: join(dir, randomUUID()), shell },
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(WANT);
    expect(r.exit_code).toBe(0);
  });

  it.each(SHELLS)("the argv's own exit code, login shell %s", async (shell) => {
    const r = await runExec(
      {
        command: null,
        argv: ["sh", "-c", "exit 7"],
        cwd: null,
        timeout_ms: 10_000,
        stdin: null,
      },
      { workdir: work, logDir: join(dir, randomUUID()), shell },
    );
    expect(r.exit_code).toBe(7);
  });

  it.each(SHELLS)("a job, login shell %s", async (shell) => {
    const jobs = new JobManager(join(dir, randomUUID()), { shell });
    const job_id = randomUUID();
    const agent_id = randomUUID();
    jobs.submit({
      job_id,
      operation_id: job_id,
      agent_id,
      source_project_id: randomUUID(),
      name: null,
      description: "argv",
      command: null,
      argv: ARGV,
      cwd: work,
      nice: false,
      exclusive: false,
      auth: {
        computer_epoch: 0,
        policy_epoch: 0,
        privacy_epoch: 0,
        deadline_at: null,
      },
    });
    const start = Date.now();
    for (;;) {
      jobs.refresh();
      const state = jobs.get(job_id)?.state;
      if (state !== "running" && state !== "starting" && state !== "queued")
        break;
      if (Date.now() - start > 10_000) throw new Error(`still ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(jobs.get(job_id)!.exit_code).toBe(0);
    expect(jobs.logs(job_id, agent_id, 100)).toBe(WANT);
    expect(jobs.summaries(agent_id)[0].command).toMatch(/^printf '%s\|' /);
  });
});
