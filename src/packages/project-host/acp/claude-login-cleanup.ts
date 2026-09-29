/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessOwner } from "./harness-reaper";

export const CLAUDE_LOGIN_PREFIX = "cocalc-claude-login-";
export const CLAUDE_LOGIN_OWNER = ".cocalc-login-owner";

async function ownerAlive(owner: string): Promise<boolean> {
  if (!/^\d+:[0-9a-f-]{36}:\d+$/.test(owner))
    throw Error("Invalid Claude login owner");
  try {
    return (await harnessOwner(Number(owner.split(":")[0]))) === owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ACP_WORKER_NOT_FOUND")
      return false;
    throw error;
  }
}

/** Called only for private, host-owned staging homes, never project paths. */
export async function killClaudeLoginProcesses(home: string): Promise<void> {
  const killed = new Map<number, string>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      const stat = await lstat(`/proc/${pid}`);
      if (stat.uid !== process.getuid!()) continue;
      const owner = await harnessOwner(pid);
      const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      if (!env.includes(`CLAUDE_CONFIG_DIR=${home}`)) continue;
      if ((await harnessOwner(pid)) !== owner) continue;
      const fields = await readFile(`/proc/${pid}/stat`, "utf8");
      const group = fields.slice(fields.lastIndexOf(")") + 2).split(/\s+/)[2];
      process.kill(group === entry ? -pid : pid, "SIGKILL");
      killed.set(pid, owner);
    } catch (error) {
      if (
        !["ENOENT", "ESRCH", "EACCES", "ACP_WORKER_NOT_FOUND"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  const deadline = Date.now() + 5000;
  while (killed.size) {
    for (const [pid, owner] of killed) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        if (
          stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ") ||
          (await harnessOwner(pid)) !== owner
        )
          killed.delete(pid);
      } catch (error) {
        if (
          ["ENOENT", "ACP_WORKER_NOT_FOUND"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          killed.delete(pid);
        else throw error;
      }
    }
    if (!killed.size) break;
    if (Date.now() > deadline)
      throw Error("Claude login processes have not stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function reapAbandonedClaudeLogins(
  root = tmpdir(),
): Promise<void> {
  let failed = false;
  for (const name of await readdir(root)) {
    if (!name.startsWith(CLAUDE_LOGIN_PREFIX)) continue;
    try {
      await reapHome(join(root, name));
    } catch {
      // One damaged staging directory must not retain every other login.
      failed = true;
    }
  }
  if (failed) throw Error("Claude sign-in cleanup requires retry");
}

async function reapHome(home: string): Promise<void> {
  const stat = await lstat(home).catch(() => undefined);
  if (
    !stat ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o077) !== 0
  )
    return;
  try {
    const marker = join(home, CLAUDE_LOGIN_OWNER);
    const ownerStat = await lstat(marker);
    if (
      !ownerStat.isFile() ||
      ownerStat.isSymbolicLink() ||
      ownerStat.size > 256
    )
      return;
    if (await ownerAlive((await readFile(marker, "utf8")).trim())) return;
  } catch (error) {
    // Also clean legacy staging homes from versions without an owner marker.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Creation and marker publication are separate filesystem operations.
    if (Date.now() - stat.mtimeMs < 60_000) return;
  }
  await killClaudeLoginProcesses(home);
  await rm(home, { recursive: true, force: true });
}
