/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessOwner } from "./harness-reaper";
import { isValidUUID } from "@cocalc/util/misc";
import { stopClaudeLoginContainers } from "./claude-login-runtime";

export const CLAUDE_LOGIN_PREFIX = "cocalc-claude-login-";
export const CLAUDE_LOGIN_OWNER = ".cocalc-login-owner";
export const CLAUDE_LOGIN_RECOVERY = ".cocalc-login-recovery.json";
export interface ClaudeLoginRecovery {
  projectId: string;
  accountId: string;
  credentialId?: string;
  holder: string;
  codeSubmitted: boolean;
  published: boolean;
  abandoned?: boolean;
  runtimeId?: string;
  containment?: "podman-v1";
  nativeStarted?: boolean;
}

async function readRecovery(
  home: string,
): Promise<ClaudeLoginRecovery | undefined> {
  const path = join(home, CLAUDE_LOGIN_RECOVERY);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw Error("Invalid Claude sign-in recovery record");
    const record = JSON.parse(await readFile(path, "utf8"));
    if (
      ![record.projectId, record.accountId, record.holder].every(isValidUUID) ||
      (record.credentialId != null && !isValidUUID(record.credentialId)) ||
      (record.runtimeId != null &&
        !/^\d+:[0-9a-f-]{36}:\d+$/.test(record.runtimeId)) ||
      typeof record.codeSubmitted !== "boolean" ||
      typeof record.published !== "boolean" ||
      (record.containment != null && record.containment !== "podman-v1") ||
      (record.nativeStarted != null &&
        typeof record.nativeStarted !== "boolean")
    )
      throw Error("Invalid Claude sign-in recovery record");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

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
  const record = await readRecovery(home);
  if (!record || record.containment !== "podman-v1")
    throw Error(
      "Legacy Claude sign-in shutdown requires operator reconciliation",
    );
  if (record.nativeStarted === false) return;
  await stopClaudeLoginContainers(record);
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
    if (
      (await ownerAlive((await readFile(marker, "utf8")).trim())) &&
      !(await readRecovery(home))?.abandoned
    )
      return;
  } catch (error) {
    // Missing/legacy records never constitute proof of native shutdown.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Creation and marker publication are separate filesystem operations.
    if (Date.now() - stat.mtimeMs < 60_000) return;
  }
  await killClaudeLoginProcesses(home);
  const recovery = await readRecovery(home);
  if (recovery) {
    // An uncertain exchange may have rotated the provider's credential. Keep
    // both the private home and ownership until an operator reconciles it.
    if (recovery.codeSubmitted && !recovery.published)
      throw Error("Claude sign-in requires credential reconciliation");
    const { manageClaudeControllerOwnership } =
      await import("./claude-subscription-registry");
    await manageClaudeControllerOwnership({
      ...recovery,
      operation: "release",
    });
  }
  await rm(home, { recursive: true, force: true });
}
