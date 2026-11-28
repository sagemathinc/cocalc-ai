/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The launch gate: the one place that decides which user namespace a new
container gets, and the only place that mints the policies podman needs for
create, run, exec and build (see @cocalc/backend/podman/launch-policy).

The host's mode (COCALC_PROJECT_RUNTIME_UID_MODE):
- unset or exactly "keep-id": today's behavior. Every launcher gets exactly
  the arguments it always had.
- exactly "separate": project containers run their user as the separate
  uid, or don't start; every side container (agent harness, Claude
  controller, Codex, shared browser, sandbox exec, rootfs scan, rootfs
  build) is refused, until each is moved onto the project's ids.
- anything else: invalid, treated as the strictest case. Project starts and
  side containers are all refused.
*/

import { mintPodmanLaunchPolicy } from "@cocalc/backend/podman/launch-policy-mint";
import {
  PodmanLaunchRefused,
  type PodmanLaunchKind,
  type PodmanLaunchPolicy,
  type PodmanLaunchVerb,
} from "@cocalc/backend/podman/launch-policy";
import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_UID,
} from "@cocalc/util/project-runtime";
import type { RuntimeIdentity } from "./runtime-identity";

export type HostRuntimeUidState = "keep-id" | "separate" | "invalid";

/** The configured mode, exactly as set: whitespace or typos are invalid.
 * An invalid value is reported as "invalid", never as set. */
export function hostRuntimeUidMode(env: NodeJS.ProcessEnv = process.env): {
  configured: string;
  state: HostRuntimeUidState;
} {
  const value = env.COCALC_PROJECT_RUNTIME_UID_MODE;
  if (value == null || value === "" || value === "keep-id") {
    return { configured: "keep-id", state: "keep-id" };
  }
  if (value === "separate") return { configured: value, state: "separate" };
  return { configured: "invalid", state: "invalid" };
}

// What a user sees when a side container is refused on a separate host.
export const SIDE_LAUNCH_UNAVAILABLE =
  "This feature is not available on this host yet.";

export class RuntimeUidModeUnavailableError extends PodmanLaunchRefused {
  readonly detail?: string;
  constructor(reason: string, detail?: string) {
    super(
      reason,
      "This host can't start projects right now. Please try again later or contact support.",
    );
    this.name = "RuntimeUidModeUnavailableError";
    this.detail = detail;
  }
}

export class SideLaunchUnavailableError extends PodmanLaunchRefused {
  readonly kind: PodmanLaunchKind;
  constructor(kind: PodmanLaunchKind, reason: string) {
    super(reason, SIDE_LAUNCH_UNAVAILABLE);
    this.name = "SideLaunchUnavailableError";
    this.kind = kind;
  }
}

/** The project container's start: separate when configured, or refused. */
export function projectLaunchPolicy(
  identity: RuntimeIdentity,
  {
    env = process.env,
    extraUserArgs = [],
  }: { env?: NodeJS.ProcessEnv; extraUserArgs?: readonly string[] } = {},
): PodmanLaunchPolicy {
  const { state } = hostRuntimeUidMode(env);
  if (state === "invalid") {
    throw new RuntimeUidModeUnavailableError("mode-invalid");
  }
  if (state === "separate" && identity.mode !== "separate") {
    throw new RuntimeUidModeUnavailableError(
      identity.status.reason ?? "unknown",
      identity.status.detail,
    );
  }
  if (state === "keep-id" && identity.mode !== "keep-id") {
    // a decision that doesn't match the configuration: never launch it
    throw new RuntimeUidModeUnavailableError("mode-mismatch");
  }
  return mintPodmanLaunchPolicy({
    kind: "project",
    verb: "create",
    usernsArgs: [...identity.usernsArgs, ...extraUserArgs],
  });
}

const KEEP_ID_PROJECT_USER = [
  `--userns=keep-id:uid=${DEFAULT_PROJECT_RUNTIME_UID},gid=${DEFAULT_PROJECT_RUNTIME_GID}`,
  "--user",
  `${DEFAULT_PROJECT_RUNTIME_UID}:${DEFAULT_PROJECT_RUNTIME_GID}`,
];

type SideKind = Exclude<
  PodmanLaunchKind,
  "project" | "exec-project" | "exec-sidecar"
>;

/**
 * The user namespace arguments each side launcher has always used on a
 * keep-id host (unchanged, so their argv stay byte-identical).
 */
export function keepIdSideUsernsArgs(
  kind: SideKind,
  opts: { hostUid?: number; hostGid?: number } = {},
): string[] {
  switch (kind) {
    case "acp-harness":
    case "codex":
    case "shared-browser":
    case "sandbox-exec":
      return [...KEEP_ID_PROJECT_USER];
    case "claude-controller": {
      const { hostUid, hostGid } = opts;
      if (!Number.isInteger(hostUid) || !Number.isInteger(hostGid)) {
        throw Error("claude-controller needs the host uid and gid");
      }
      return ["--userns=keep-id", "--user", `${hostUid}:${hostGid}`];
    }
    case "rootfs-scan":
    case "rootfs-build":
      // no user namespace flags (the rootless default)
      return [];
  }
}

/**
 * A side container (anything but the project's own): allowed with today's
 * arguments on a keep-id host, refused on a separate or invalid one. A
 * refusal issues no podman command at all.
 */
export function sideLaunchPolicy(
  kind: SideKind,
  verb: Extract<PodmanLaunchVerb, "create" | "run" | "build">,
  opts: {
    env?: NodeJS.ProcessEnv;
    hostUid?: number;
    hostGid?: number;
  } = {},
): PodmanLaunchPolicy {
  const { state } = hostRuntimeUidMode(opts.env);
  if (state !== "keep-id") {
    throw new SideLaunchUnavailableError(
      kind,
      state === "invalid" ? "mode-invalid" : "separate-host",
    );
  }
  return mintPodmanLaunchPolicy({
    kind,
    verb,
    usernsArgs: keepIdSideUsernsArgs(kind, opts),
  });
}

const PROJECT_CONTAINER =
  /^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * podman exec into an existing container. Exec inherits the container's user
 * namespace, so a project container is fine in any mode (on a separate host
 * it runs under the separate map). Any other container is a side container:
 * refused on a separate or invalid host, as its launch would be.
 * userArgs is the exec's own --user/-u choice, if any. feature names a side
 * feature the exec runs (Codex, an agent, sandbox exec): those are refused
 * on a separate or invalid host even inside the project's own container,
 * until each is moved onto the project's ids.
 */
export function execLaunchPolicy(
  container: string,
  {
    userArgs = [],
    feature,
    env,
  }: {
    userArgs?: readonly string[];
    feature?: SideKind;
    env?: NodeJS.ProcessEnv;
  } = {},
): PodmanLaunchPolicy {
  if (userArgs.length % 2 !== 0) {
    throw Error("exec userArgs must be pairs of --user/-u and a user");
  }
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i];
    const isFlag = /^(--user|-u)$/.test(arg);
    if (i % 2 === 0 ? !isFlag : isFlag || arg.startsWith("-")) {
      throw Error("exec userArgs must be pairs of --user/-u and a user");
    }
  }
  const projectContainer = PROJECT_CONTAINER.test(container);
  const { state } = hostRuntimeUidMode(env);
  // An invalid mode refuses every exec (the strictest case); a separate host
  // allows only a plain exec into a project's own container (its own map).
  if (state === "invalid" || !projectContainer || feature != null) {
    if (state !== "keep-id") {
      throw new SideLaunchUnavailableError(
        feature ?? "exec-sidecar",
        state === "invalid" ? "mode-invalid" : "separate-host",
      );
    }
  }
  return mintPodmanLaunchPolicy({
    kind: projectContainer ? "exec-project" : "exec-sidecar",
    verb: "exec",
    usernsArgs: userArgs,
    container,
  });
}
