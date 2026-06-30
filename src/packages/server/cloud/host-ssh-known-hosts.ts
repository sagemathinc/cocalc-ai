/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import getLogger from "@cocalc/backend/logger";

const execFileAsync = promisify(execFile);
const logger = getLogger("server:cloud:host-ssh-known-hosts");

export function sshHostKeyAliasForHostId(host_id: string): string {
  return `cocalc-host-${host_id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function userKnownHostsPath(): string {
  return (
    process.env.COCALC_SSH_KNOWN_HOSTS_FILE ??
    join(homedir(), ".ssh", "known_hosts")
  );
}

export async function removeHostSshKnownHostAlias({
  host_id,
  reason,
}: {
  host_id: string;
  reason: string;
}): Promise<void> {
  const alias = sshHostKeyAliasForHostId(host_id);
  const knownHosts = userKnownHostsPath();
  try {
    await access(knownHosts);
  } catch {
    logger.debug("known_hosts file does not exist; nothing to remove", {
      host_id,
      alias,
      reason,
      known_hosts: knownHosts,
    });
    return;
  }
  try {
    await execFileAsync("ssh-keygen", ["-f", knownHosts, "-R", alias]);
    logger.info("removed host ssh known_hosts alias", {
      host_id,
      alias,
      reason,
      known_hosts: knownHosts,
    });
  } catch (err) {
    logger.warn("failed to remove host ssh known_hosts alias", {
      host_id,
      alias,
      reason,
      known_hosts: knownHosts,
      err: `${err}`,
    });
  }
}
