/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isValidUUID } from "@cocalc/util/misc";
import getLogger from "@cocalc/backend/logger";
import {
  claudeSubscriptionBundleFiles,
  packClaudeSubscriptionBundle,
  readClaudeSubscriptionHomeFiles,
} from "./claude-subscription-home";
import {
  manageClaudeControllerOwnership,
  syncClaudeSubscriptionCredential,
} from "./claude-subscription-registry";
import { isManagedClaudeControllerHome } from "./claude-subscription-paths";

export const CLAUDE_CONTROLLER_HOLDER_LABEL = "cocalc.acp.controller-holder";
const logger = getLogger("project-host:claude-controller-recovery");
export interface ClaudeControllerJournal {
  projectId: string;
  accountId: string;
  credentialId: string;
  holder: string;
  home: string;
  worker: string;
  mayHaveLaunched: boolean;
  baseline?: string;
}
export function claudeControllerJournalDirectory(): string {
  return join(
    process.env.COCALC_DATA ?? process.env.DATA ?? tmpdir(),
    "claude-controller-ownership",
  );
}
export async function saveClaudeControllerJournal(
  record: ClaudeControllerJournal,
  directory = claudeControllerJournalDirectory(),
): Promise<void> {
  if (!isValidUUID(record.holder))
    throw Error("Invalid Claude controller journal");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${record.holder}.${randomUUID()}.tmp`);
  // This host-only directory is never mounted in a credential controller or project.
  await writeFile(temporary, JSON.stringify(record), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, join(directory, `${record.holder}.json`));
}
export async function removeClaudeControllerJournal(
  holder: string,
  directory = claudeControllerJournalDirectory(),
): Promise<void> {
  if (!isValidUUID(holder)) throw Error("Invalid Claude controller journal");
  await rm(join(directory, `${holder}.json`), { force: true });
}

/** Stop is confirmed independently of a dead worker, before reading or publishing. */
export async function recoverClaudeControllerJournal(
  record: ClaudeControllerJournal,
  stop: () => Promise<void>,
  directory = claudeControllerJournalDirectory(),
): Promise<void> {
  if (
    ![
      record.projectId,
      record.accountId,
      record.credentialId,
      record.holder,
    ].every(isValidUUID) ||
    !isManagedClaudeControllerHome(record.home)
  )
    throw Error("Invalid Claude controller journal");
  await stop();
  if (record.mayHaveLaunched) {
    if (!record.baseline)
      throw Error("Claude controller recovery baseline unavailable");
    const baseline = claudeSubscriptionBundleFiles(record.baseline);
    const current = await readClaudeSubscriptionHomeFiles(record.home, [
      ...baseline.keys(),
    ]);
    await syncClaudeSubscriptionCredential({
      ...record,
      baseline,
      current,
      controllerHolder: record.holder,
      runtimeId: record.worker,
    });
    record.baseline = packClaudeSubscriptionBundle(current);
    await saveClaudeControllerJournal(record, directory);
  }
  await manageClaudeControllerOwnership({
    ...record,
    runtimeId: record.worker,
    operation: "release",
  });
  await rm(record.home, { recursive: true, force: true });
  await removeClaudeControllerJournal(record.holder, directory);
}

export async function listClaudeControllerJournals(
  directory = claudeControllerJournalDirectory(),
): Promise<ClaudeControllerJournal[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: ClaudeControllerJournal[] = [];
  for (const name of names.filter((name) =>
    /^[0-9a-f-]{36}\.json$/.test(name),
  )) {
    try {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3_000_000)
        throw Error("Unsafe Claude controller journal");
      records.push(JSON.parse(await readFile(path, "utf8")));
    } catch {
      // Preserve the damaged record, without blocking unrelated recovery.
      logger.warn("Claude controller journal requires reconciliation", {
        failureCategory: "invalid_recovery_record",
      });
    }
  }
  return records;
}
