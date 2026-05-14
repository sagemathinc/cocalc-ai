/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import getLogger from "@cocalc/backend/logger";
import type { GenerateProjectSshKeySecretResult } from "@cocalc/conat/hub/api/projects";
import {
  PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
  normalizeProjectSecretName,
} from "@cocalc/util/project-secrets";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  getProjectSecretsRuntimeCache,
  listProjectSecrets,
  setProjectSecret,
} from "./project-secrets";

const execFileAsync = promisify(execFile);
const logger = getLogger("server:projects:project-secret-ssh-key");

async function generateEd25519Keypair({
  project_id,
}: {
  project_id: string;
}): Promise<{ private_key: string; public_key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cocalc-project-ssh-key-"));
  const privateKeyPath = join(dir, "id_ed25519");
  try {
    await execFileAsync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      `cocalc-project:${project_id}`,
      "-f",
      privateKeyPath,
    ]);
    const private_key = await readFile(privateKeyPath, "utf8");
    const public_key = await readFile(`${privateKeyPath}.pub`, "utf8");
    if (!private_key.endsWith("\n")) {
      throw new Error(
        "ssh-keygen generated a private key without final newline",
      );
    }
    return { private_key, public_key: public_key.trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function generateProjectSshKeySecretLocal({
  project_id,
  account_id,
  secret_name = PROJECT_SECRETS_SSH_PRIVATE_KEY_NAME,
}: {
  project_id: string;
  account_id: string;
  secret_name?: string;
}): Promise<GenerateProjectSshKeySecretResult> {
  const normalizedSecretName = normalizeProjectSecretName(secret_name);
  const existingSecrets = await listProjectSecrets({ project_id });
  if (existingSecrets.some(({ name }) => name === normalizedSecretName)) {
    throw new Error(`project secret ${normalizedSecretName} already exists`);
  }

  const { host_id } = await getAssignedProjectHostInfo(project_id);
  const client = await getRoutedHostControlClient({
    host_id,
    timeout: 30_000,
  });
  const preflight = await client.setupProjectSecretSshKey({
    project_id,
    secret_name: normalizedSecretName,
    check_only: true,
  });

  const { private_key, public_key } = await generateEd25519Keypair({
    project_id,
  });
  const secret = await setProjectSecret({
    project_id,
    name: normalizedSecretName,
    value: private_key,
    account_id,
    overwrite: false,
  });

  try {
    const cache = await getProjectSecretsRuntimeCache({ project_id });
    await client.syncProjectSecretsCache({ project_id, cache });
  } catch (err) {
    logger.warn("generateProjectSshKeySecretLocal: cache sync failed", {
      project_id,
      host_id,
      err: `${err}`,
    });
  }

  try {
    const setup = await client.setupProjectSecretSshKey({
      project_id,
      secret_name: normalizedSecretName,
      public_key,
    });
    return {
      secret,
      secret_name: normalizedSecretName,
      public_key,
      setup: { ok: true, ...setup },
      restart_required: true,
    };
  } catch (err) {
    logger.warn("generateProjectSshKeySecretLocal: host setup failed", {
      project_id,
      host_id,
      err: `${err}`,
    });
    return {
      secret,
      secret_name: normalizedSecretName,
      public_key,
      setup: { ok: false, ...preflight, error: `${err}` },
      restart_required: true,
    };
  }
}
