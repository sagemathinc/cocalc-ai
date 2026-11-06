/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
How a project's rootfs agent is started: `podman exec -i` into the
project's container (by its id, never its name), as the project user, with
no new privileges, a fixed small environment, and code that comes from the
host (the bundle's node runs it), never from the project's rootfs.

agentExecArgs() builds the arguments; checkAgentExecArgs() accepts exactly
that shape and nothing else, and runs before every spawn. No tty, no
privileges, no capabilities, no other security option, no other user, no
environment from anywhere but the allowlist.
*/

import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_HOME,
  DEFAULT_PROJECT_RUNTIME_UID,
  DEFAULT_PROJECT_RUNTIME_USER,
} from "@cocalc/util/project-runtime";

export const AGENT_USER = `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`;
export const AGENT_SECURITY_OPT = "--security-opt=no-new-privileges";

// The environment the spawn sets. `podman exec` merges it over the
// container's configured environment (which the project may set), so the
// variables that change how node or the loader start are set explicitly
// empty. PATH holds the bundle's tools only.
export const AGENT_BLANKED_ENV = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
];
export const AGENT_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  ...AGENT_BLANKED_ENV,
];

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const SAFE_VALUE = /^[A-Za-z0-9_./:@+-]*$/;

export interface AgentExecOptions {
  // the project container's full id, from `podman inspect --format {{.Id}}`
  containerId: string;
  // the bundle's node, as the container sees it (a read-only host mount)
  nodePath: string;
  // the agent's code (host-built)
  agentCode: string;
  // marks this agent's process, to find and stop it inside the container
  token: string;
  // the bundle's tools directory, as the container sees it
  toolsPath: string;
}

export function agentEnv({
  toolsPath,
}: Pick<AgentExecOptions, "toolsPath">): Record<string, string> {
  return {
    HOME: DEFAULT_PROJECT_RUNTIME_HOME,
    USER: DEFAULT_PROJECT_RUNTIME_USER,
    LOGNAME: DEFAULT_PROJECT_RUNTIME_USER,
    PATH: toolsPath,
    LANG: "C.UTF-8",
    ...Object.fromEntries(AGENT_BLANKED_ENV.map((key) => [key, ""])),
  };
}

export function agentExecArgs(opts: AgentExecOptions): string[] {
  const args = [
    "exec",
    "-i",
    "--user",
    AGENT_USER,
    AGENT_SECURITY_OPT,
    "--workdir",
    DEFAULT_PROJECT_RUNTIME_HOME,
  ];
  for (const [key, value] of Object.entries(agentEnv(opts))) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(
    opts.containerId,
    opts.nodePath,
    "-e",
    opts.agentCode,
    "--",
    opts.token,
  );
  checkAgentExecArgs(args, opts);
  return args;
}

/** Throws unless args are exactly what agentExecArgs(opts) builds. */
export function checkAgentExecArgs(
  args: string[],
  opts: AgentExecOptions,
): void {
  const fail = (why: string): never => {
    throw new Error(`refusing to start the rootfs agent: ${why}`);
  };
  if (!CONTAINER_ID.test(opts.containerId)) fail("not a full container id");
  if (!TOKEN.test(opts.token)) fail("bad token");
  if (!opts.nodePath.startsWith("/") || !SAFE_VALUE.test(opts.nodePath)) {
    fail("bad node path");
  }
  const head = [
    "exec",
    "-i",
    "--user",
    AGENT_USER,
    AGENT_SECURITY_OPT,
    "--workdir",
    DEFAULT_PROJECT_RUNTIME_HOME,
  ];
  head.forEach((want, i) => {
    if (args[i] !== want) fail(`argument ${i} is not ${want}`);
  });
  const env = agentEnv(opts);
  const keys = Object.keys(env);
  let i = head.length;
  for (const key of keys) {
    if (args[i] !== "--env" || args[i + 1] !== `${key}=${env[key]}`) {
      fail(`environment entry ${key} is not the allowlisted one`);
    }
    if (!SAFE_VALUE.test(env[key].replace(/ /g, ""))) {
      fail(`environment value of ${key} is unsafe`);
    }
    i += 2;
  }
  const tail = [
    opts.containerId,
    opts.nodePath,
    "-e",
    opts.agentCode,
    "--",
    opts.token,
  ];
  tail.forEach((want, j) => {
    if (args[i + j] !== want) fail(`argument ${i + j} is not the expected one`);
  });
  if (args.length !== i + tail.length) fail("unexpected extra arguments");
  if (keys.join(",") !== AGENT_ENV_KEYS.join(",")) {
    fail("the environment keys are not the allowlist");
  }
}
