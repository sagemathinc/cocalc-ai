/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { secrets } from "@cocalc/backend/data";

function rootfsRusticProfileDir(): string {
  if (!secrets) {
    throw new Error("SECRETS path is not configured");
  }
  return join(secrets, "rustic", "rootfs-images");
}

function profileName(repo_selector: string, repo_toml: string): string {
  const digest = createHash("sha256")
    .update(`${repo_selector}\0${repo_toml}`)
    .digest("hex");
  return `${digest}.toml`;
}

export async function ensureRootfsRusticRepoProfile({
  repo_selector,
  repo_toml,
}: {
  repo_selector: string;
  repo_toml: string;
}): Promise<string> {
  const profileDir = rootfsRusticProfileDir();
  const path = join(profileDir, profileName(repo_selector, repo_toml));
  try {
    if ((await readFile(path, "utf8")) === repo_toml) {
      return path;
    }
  } catch {
    // write below
  }
  await mkdir(profileDir, { recursive: true });
  await writeFile(path, repo_toml, "utf8");
  await chmod(path, 0o600);
  return path;
}
