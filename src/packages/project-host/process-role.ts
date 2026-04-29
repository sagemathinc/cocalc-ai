/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type ProjectHostProcessRole =
  | "app"
  | "host-agent"
  | "conat-router"
  | "conat-persist"
  | "acp-worker"
  | "conat-router-cluster-node"
  | "privileged-rm-helper";

type RoleOpts = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  args?: string[];
};

function envFlag(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
): boolean {
  return `${env[key] ?? ""}`.trim() === "1";
}

export function getProjectHostProcessRole({
  env = process.env,
  args = process.argv.slice(2),
}: RoleOpts = {}): ProjectHostProcessRole {
  if (args[0] === "privileged-rm-helper") {
    return "privileged-rm-helper";
  }
  if (envFlag(env, "COCALC_CONAT_CLUSTER_NODE")) {
    return "conat-router-cluster-node";
  }
  if (envFlag(env, "COCALC_PROJECT_HOST_ACP_WORKER")) {
    return "acp-worker";
  }
  if (envFlag(env, "COCALC_PROJECT_HOST_CONAT_ROUTER_DAEMON")) {
    return "conat-router";
  }
  if (envFlag(env, "COCALC_PROJECT_HOST_CONAT_PERSIST_DAEMON")) {
    return "conat-persist";
  }
  if (envFlag(env, "COCALC_PROJECT_HOST_AGENT")) {
    return "host-agent";
  }
  return "app";
}

export function getProjectHostProcessTitle(opts: RoleOpts = {}): string {
  const env = opts.env ?? process.env;
  const role = getProjectHostProcessRole(opts);
  switch (role) {
    case "host-agent": {
      const index = `${env.COCALC_PROJECT_HOST_AGENT_INDEX ?? ""}`.trim();
      return index.length > 0
        ? `project-host:host-agent:${index}`
        : "project-host:host-agent";
    }
    case "conat-router-cluster-node":
      return "project-host:conat-router-cluster-node";
    case "conat-router":
      return "project-host:conat-router";
    case "conat-persist":
      return "project-host:conat-persist";
    case "acp-worker":
      return "project-host:acp-worker";
    case "privileged-rm-helper":
      return "project-host:privileged-rm-helper";
    case "app":
    default:
      return "project-host:app";
  }
}

export function applyProjectHostProcessTitle(
  opts: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    args?: string[];
    processRef?: NodeJS.Process;
  } = {},
): string {
  const processRef = opts.processRef ?? process;
  const title = getProjectHostProcessTitle(opts);
  try {
    processRef.title = title;
  } catch {
    // best effort only
  }
  return title;
}
