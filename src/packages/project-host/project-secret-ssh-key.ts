/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeProjectSecretName,
  PROJECT_SECRETS_MOUNT_PATH,
  PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
  PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH,
  PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH,
  type ProjectSecretSshKeySetupResult,
} from "@cocalc/util/project-secrets";
import { ensureVolume } from "./file-server";

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

function setupResult(secret_name: string): ProjectSecretSshKeySetupResult {
  return {
    private_key_path: PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH,
    public_key_path: PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH,
    symlink_target: join(PROJECT_SECRETS_MOUNT_PATH, secret_name),
  };
}

export async function setupProjectSecretSshKey({
  project_id,
  secret_name = PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
  public_key,
  check_only = false,
}: {
  project_id: string;
  secret_name?: string;
  public_key?: string;
  check_only?: boolean;
}): Promise<ProjectSecretSshKeySetupResult> {
  const normalizedSecretName = normalizeProjectSecretName(secret_name);
  const result = setupResult(normalizedSecretName);
  const vol = await ensureVolume(project_id);
  const sshDir = join(vol.path, ".ssh");
  const privateKeyPath = join(vol.path, PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH);
  const publicKeyPath = join(vol.path, PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH);

  const sshDirStat = await lstatIfExists(sshDir);
  if (
    sshDirStat?.isSymbolicLink() ||
    (sshDirStat && !sshDirStat.isDirectory())
  ) {
    throw new Error(".ssh exists but is not a directory");
  }
  if (await lstatIfExists(privateKeyPath)) {
    throw new Error(`${PROJECT_SECRETS_SSH_PRIVATE_KEY_PATH} already exists`);
  }
  if (await lstatIfExists(publicKeyPath)) {
    throw new Error(`${PROJECT_SECRETS_SSH_PUBLIC_KEY_PATH} already exists`);
  }
  if (check_only) {
    return result;
  }
  const formattedPublicKey = `${public_key ?? ""}`.trim();
  if (!formattedPublicKey) {
    throw new Error("public SSH key is required");
  }

  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  await chmod(sshDir, 0o700);
  try {
    await writeFile(publicKeyPath, `${formattedPublicKey}\n`, {
      mode: 0o644,
      flag: "wx",
    });
    await symlink(result.symlink_target, privateKeyPath);
  } catch (err) {
    await rm(publicKeyPath, { force: true }).catch(() => undefined);
    throw err;
  }
  return result;
}
