/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ONPREM_REST_TUNNEL_LOCAL_PORT } from "@cocalc/conat/project-host/api";

import { getLaunchpadLocalConfig } from "./mode";
import {
  getLaunchpadRestAuth,
  getLaunchpadRestPort,
  maybeStartLaunchpadOnPremServices,
} from "./onprem-sshd";

const LOCAL_REST_REPO_ROOT = "rustic";

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function buildLaunchpadRestRusticRepoConfig({
  root,
  password,
}: {
  root: string;
  password: string;
}): Promise<
  | {
      repo_toml: string;
      repo_selector: string;
      endpoint: string;
      repo_root: string;
    }
  | undefined
> {
  await maybeStartLaunchpadOnPremServices();
  const config = getLaunchpadLocalConfig("local");
  const restPort = getLaunchpadRestPort() ?? config.rest_port;
  if (!restPort || !config.backup_root) {
    return undefined;
  }
  const repoRoot = join(config.backup_root, LOCAL_REST_REPO_ROOT, root);
  try {
    await mkdir(repoRoot, { recursive: true });
  } catch {
    // rustic will surface a clearer error later if this path is unusable
  }
  const auth = await getLaunchpadRestAuth();
  const authPrefix = auth
    ? `${encodeURIComponent(auth.user)}:${encodeURIComponent(auth.password)}@`
    : "";
  const tunnelLocalPort =
    Number.parseInt(
      process.env.COCALC_ONPREM_REST_TUNNEL_LOCAL_PORT ?? "",
      10,
    ) || ONPREM_REST_TUNNEL_LOCAL_PORT;
  const endpoint = `http://${authPrefix}127.0.0.1:${tunnelLocalPort}/${encodePath(root)}`;
  return {
    repo_toml: [
      "[repository]",
      `repository = "rest:${endpoint}"`,
      `password = "${password}"`,
      "",
    ].join("\n"),
    repo_selector: `rest:${root}`,
    endpoint,
    repo_root: repoRoot,
  };
}
