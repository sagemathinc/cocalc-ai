/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Podman verbs that start code in a container (create, run, exec, build) take a
policy: proof that the launch gate (project-runner/run/podman-launch.ts)
decided which user namespace the container gets. The podman wrappers
(./command.ts) refuse these verbs without one, and refuse user namespace
flags (--userns, --uidmap, --gidmap, --user, -u) that didn't come from it.

Only the gate mints policies (./launch-policy-mint.ts; a structural test
checks that nothing else imports it).
*/

export type PodmanLaunchVerb = "create" | "run" | "exec" | "build";

export const PODMAN_LAUNCH_VERBS: readonly PodmanLaunchVerb[] = [
  "create",
  "run",
  "exec",
  "build",
];

// What a launch is for: the inventory of launchers and exec sites.
export type PodmanLaunchKind =
  | "project"
  | "acp-harness"
  | "claude-controller"
  | "codex"
  | "shared-browser"
  | "sandbox-exec"
  | "rootfs-scan"
  | "rootfs-build"
  | "exec-project"
  | "exec-sidecar";

const MINT = Symbol("podman-launch-policy");
// Policies the constructor made: an object that only claims the prototype
// (Object.create) is not one.
const MINTED = new WeakSet<object>();

export class PodmanLaunchPolicy {
  readonly kind: PodmanLaunchKind;
  readonly verb: PodmanLaunchVerb;
  // the exact user namespace arguments, placed contiguously in the argv
  readonly usernsArgs: readonly string[];
  // exec: the container it may target
  readonly container?: string;

  constructor(
    token: symbol,
    opts: {
      kind: PodmanLaunchKind;
      verb: PodmanLaunchVerb;
      usernsArgs: readonly string[];
      container?: string;
    },
  ) {
    if (token !== MINT) {
      throw Error("podman launch policies are minted only by the launch gate");
    }
    this.kind = opts.kind;
    this.verb = opts.verb;
    this.usernsArgs = Object.freeze([...opts.usernsArgs]);
    this.container = opts.container;
    Object.freeze(this);
    MINTED.add(this);
  }
}

/** @internal for ./launch-policy-mint.ts only */
export const __mintToken = MINT;

export class PodmanLaunchRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `podman launch refused: ${reason}`);
    this.name = "PodmanLaunchRefused";
    this.reason = reason;
  }
}

// Global options podman takes before its verb, with a separate value.
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "--cgroup-manager",
  "--config",
  "--conmon",
  "--connection",
  "-c",
  "--events-backend",
  "--hooks-dir",
  "--identity",
  "--imagestore",
  "--log-level",
  "--module",
  "--network-cmd-path",
  "--network-config-dir",
  "--root",
  "--runroot",
  "--runtime",
  "--runtime-flag",
  "--ssh",
  "--storage-driver",
  "--storage-opt",
  "--tmpdir",
  "--transient-store",
  "--url",
  "--volumepath",
]);

/** The verb word of a podman argv and its index (after global options and
 * a "container"/"image" group word). */
function verbAt(args: readonly string[]): { word?: string; index: number } {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i];
    i += !arg.includes("=") && GLOBAL_OPTIONS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  if (args[i] === "container" || args[i] === "image") i += 1;
  return { word: args[i], index: i };
}

/** The verb of a podman argv ("container run" counts as "run"), if gated. */
export function podmanLaunchVerb(
  args: readonly string[],
): PodmanLaunchVerb | undefined {
  let verb = verbAt(args).word;
  if (verb === "buildx") verb = "build";
  return (PODMAN_LAUNCH_VERBS as readonly string[]).includes(verb ?? "")
    ? (verb as PodmanLaunchVerb)
    : undefined;
}

// podman exec's options: those taking a value, and the boolean ones allowed.
// Anything else (--latest, --privileged, an unknown option) has no target
// the gate can bind, so it is refused.
const EXEC_LONG_WITH_VALUE = new Set([
  "--env",
  "--env-file",
  "--user",
  "--workdir",
  "--detach-keys",
  "--preserve-fd",
  "--preserve-fds",
]);
const EXEC_LONG_BOOLEAN = new Set(["--detach", "--interactive", "--tty"]);
const EXEC_SHORT_WITH_VALUE = "euw";
const EXEC_SHORT_BOOLEAN = "dit";

/** The container operand of a podman exec argv, or undefined when it can't
 * be determined exactly. */
export function podmanExecTarget(args: readonly string[]): string | undefined {
  const { word, index } = verbAt(args);
  if (word !== "exec") return undefined;
  for (let i = index + 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args[i + 1];
    if (!arg.startsWith("-") || arg === "-") return arg;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (EXEC_LONG_WITH_VALUE.has(name)) {
        if (!arg.includes("=")) i += 1;
      } else if (!EXEC_LONG_BOOLEAN.has(arg)) {
        return undefined;
      }
      continue;
    }
    // a cluster of short options: -it, -e VALUE, -eVALUE, -u2001
    const letters = arg.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const c = letters[k];
      if (EXEC_SHORT_BOOLEAN.includes(c)) continue;
      if (!EXEC_SHORT_WITH_VALUE.includes(c)) return undefined;
      if (k === letters.length - 1) i += 1; // the value is the next word
      break; // the rest of the word is the value
    }
  }
  return undefined;
}

const USERNS_FLAG =
  /^(--userns|--uidmap|--gidmap|--user|-u|--subuidname|--subgidname)(=|$)/;

function isUsernsFlag(arg: string): boolean {
  return USERNS_FLAG.test(arg);
}

/**
 * Throws unless args may run with policy: a gated verb needs a policy for
 * that verb, and the only user namespace flags allowed are the policy's own,
 * once and contiguously. Exec must target the policy's container.
 */
export function checkPodmanLaunch(
  args: readonly string[],
  policy: PodmanLaunchPolicy | undefined,
): void {
  const verb = podmanLaunchVerb(args);
  if (verb == null) {
    if (args.some(isUsernsFlag) && policy == null) {
      // e.g. a namespace flag on a verb we don't gate: refuse rather than guess
      throw new PodmanLaunchRefused(
        "userns-flag-without-policy",
        "podman: user namespace flags need a launch policy",
      );
    }
    return;
  }
  if (policy == null || !MINTED.has(policy)) {
    throw new PodmanLaunchRefused(
      "no-policy",
      `podman ${verb} needs a launch policy from the launch gate`,
    );
  }
  if (policy.verb !== verb) {
    throw new PodmanLaunchRefused(
      "verb-mismatch",
      `podman ${verb} with a policy for ${policy.verb}`,
    );
  }
  const expected = policy.usernsArgs;
  const flagged: number[] = [];
  for (let i = 0; i < args.length; i++) {
    if (isUsernsFlag(args[i])) flagged.push(i);
  }
  if (expected.length === 0) {
    if (flagged.length > 0) {
      throw new PodmanLaunchRefused(
        "userns-flag-not-from-policy",
        "podman: user namespace flags that didn't come from the launch policy",
      );
    }
  } else {
    const start = indexOfSequence(args, expected);
    const ok =
      start >= 0 &&
      indexOfSequence(args.slice(start + expected.length), expected) < 0 &&
      flagged.every((i) => i >= start && i < start + expected.length);
    if (!ok) {
      throw new PodmanLaunchRefused(
        "userns-flag-not-from-policy",
        "podman: user namespace flags that didn't come from the launch policy",
      );
    }
  }
  if (verb === "exec") {
    if (
      policy.container == null ||
      podmanExecTarget(args) !== policy.container
    ) {
      throw new PodmanLaunchRefused(
        "exec-target",
        "podman exec must target the container its policy names",
      );
    }
  }
}

function indexOfSequence(
  args: readonly string[],
  seq: readonly string[],
): number {
  outer: for (let i = 0; i + seq.length <= args.length; i++) {
    for (let j = 0; j < seq.length; j++) {
      if (args[i + j] !== seq[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Environment overrides that could change the user namespace podman picks
 * (containers.conf "userns" and friends) are not accepted from callers.
 */
export const PODMAN_ENV_OVERRIDES_REFUSED = [
  "CONTAINERS_CONF",
  "CONTAINERS_CONF_OVERRIDE",
  "CONTAINERS_STORAGE_CONF",
  "PODMAN_USERNS",
];
