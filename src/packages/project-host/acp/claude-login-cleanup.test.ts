import { mkdtemp, mkdir, writeFile, stat, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { harnessOwner } from "./harness-reaper";
import {
  CLAUDE_LOGIN_OWNER,
  reapAbandonedClaudeLogins,
} from "./claude-login-cleanup";

test("reconciliation removes crashed-owner login state and its detached process, preserving live and symlink homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const home = join(root, "cocalc-claude-login-orphan");
  const live = join(root, "cocalc-claude-login-live");
  await mkdir(home, { mode: 0o700 });
  await mkdir(live, { mode: 0o700 });
  const owner = await harnessOwner();
  const ownerProcess = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{}, 1000)"],
    { stdio: "ignore" },
  );
  const ownerExited = once(ownerProcess, "exit");
  await writeFile(
    join(home, CLAUDE_LOGIN_OWNER),
    await harnessOwner(ownerProcess.pid!),
  );
  await writeFile(join(live, CLAUDE_LOGIN_OWNER), owner);
  await writeFile(join(home, "fixture-credential"), "fixture-only");
  await symlink(live, join(root, "cocalc-claude-login-symlink"));
  const child = spawn(
    process.execPath,
    ["-e", 'console.log("ready"); setInterval(()=>{}, 1000)'],
    {
      detached: true,
      env: { CLAUDE_CONFIG_DIR: home },
      stdio: "pipe",
    },
  );
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await reapAbandonedClaudeLogins(root);
    expect((await stat(home)).isDirectory()).toBe(true);
    ownerProcess.kill("SIGKILL");
    await ownerExited;
    await reapAbandonedClaudeLogins(root);
    await exited;
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(live)).isDirectory()).toBe(true);
  } finally {
    ownerProcess.kill("SIGKILL");
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("one malformed owner does not prevent cleanup of other abandoned homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-reaper-test-"));
  const bad = join(root, "cocalc-claude-login-a");
  const abandoned = join(root, "cocalc-claude-login-b");
  try {
    await mkdir(bad, { mode: 0o700 });
    await mkdir(abandoned, { mode: 0o700 });
    await writeFile(join(bad, CLAUDE_LOGIN_OWNER), "not-an-owner");
    await writeFile(
      join(abandoned, CLAUDE_LOGIN_OWNER),
      (await harnessOwner()) + "0",
    );
    await expect(reapAbandonedClaudeLogins(root)).rejects.toThrow(
      "requires retry",
    );
    await expect(stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(bad)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
