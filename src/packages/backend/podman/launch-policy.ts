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

const LAUNCHER_MINT = Symbol("podman-launcher");
const MINTED_LAUNCHERS = new WeakSet<object>();

/**
 * A command that runs podman for the wrappers (today: the project pool and
 * project cgroup scripts, `bash -c SCRIPT ...`). Only project-runner's
 * podman.ts makes them (./launcher-mint.ts; a structural test checks it), and
 * the wrappers refuse any other.
 */
export class PodmanLauncher {
  readonly command: string;
  readonly argsPrefix: readonly string[];

  constructor(token: symbol, command: string, argsPrefix: readonly string[]) {
    if (token !== LAUNCHER_MINT) {
      throw Error("podman launchers are made only by project-runner");
    }
    this.command = command;
    this.argsPrefix = Object.freeze([...argsPrefix]);
    Object.freeze(this);
    MINTED_LAUNCHERS.add(this);
  }
}

/** @internal for ./launcher-mint.ts only */
export const __launcherToken = LAUNCHER_MINT;

/** Throws unless launcher is one project-runner made (or absent). */
export function checkPodmanLauncher(launcher: unknown): void {
  if (launcher != null && !MINTED_LAUNCHERS.has(launcher as object)) {
    throw new PodmanLaunchRefused(
      "launcher",
      "podman: only project-runner's launchers may run podman",
    );
  }
}

export class PodmanLaunchRefused extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `podman launch refused: ${reason}`);
    this.name = "PodmanLaunchRefused";
    this.reason = reason;
  }
}

// The global options callers may pass before the verb (podman 5.8.6,
// cmd/podman/root.go): an allow-list, since an unknown option's value would
// be read as the verb, and several change what podman runs (--module,
// --connection, --url, ...). Each takes a value, attached or as the next word.
const GLOBAL_OPTIONS_ALLOWED = new Set(["--log-level"]);

// Verbs grouped under a first word ("container run", "image build", ...).
const VERB_GROUPS = new Set([
  "container",
  "image",
  "system",
  "pod",
  "network",
  "volume",
  "manifest",
  "secret",
  "generate",
  "machine",
  "kube",
  "play",
  "buildx",
  "farm",
  "artifact",
  "quadlet",
]);

// Verbs that start code in a container: they need a policy.
const LAUNCH_VERBS: Record<string, PodmanLaunchVerb> = {
  run: "run",
  create: "create",
  exec: "exec",
  build: "build",
  "container run": "run",
  "container create": "create",
  "container exec": "exec",
  "image build": "build",
  "buildx build": "build",
};

// The other verbs callers may use, none of which starts code in a container
// (an allow-list: kube play, runlabel, clone, restore, system service and
// anything new are refused).
const NON_LAUNCH_VERBS = new Set([
  "ps",
  "inspect",
  "rm",
  "rmi",
  "start",
  "stop",
  "kill",
  "wait",
  "logs",
  "info",
  "version",
  "images",
  "pull",
  "top",
  "stats",
  "port",
  "events",
  "unshare",
  "container exists",
  "container inspect",
  "container ps",
  "container list",
  "container ls",
  "container rm",
  "container start",
  "container stop",
  "container kill",
  "container wait",
  "container logs",
  "container top",
  "container stats",
  "container port",
  "image exists",
  "image inspect",
  "image ls",
  "image list",
  "image rm",
  "image pull",
  "system migrate",
  "system info",
  "system df",
]);

interface ParsedVerb {
  // "run", "container run", ...: undefined when there is none
  key?: string;
  // index of the verb's last word
  index: number;
  // a leading option that isn't allowed
  badOption?: string;
}

/** The verb of a podman argv, after the allowed global options. */
export function parsePodmanVerb(args: readonly string[]): ParsedVerb {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const arg = args[i];
    const name = arg.split("=")[0];
    if (args.length === 1 && arg === "--version")
      return { key: "version", index: 0 };
    if (!GLOBAL_OPTIONS_ALLOWED.has(name)) return { index: i, badOption: name };
    i += arg.includes("=") ? 1 : 2;
  }
  const first = args[i];
  if (first == null) return { index: i };
  if (VERB_GROUPS.has(first)) {
    const sub = args[i + 1];
    return sub == null || sub.startsWith("-")
      ? { key: first, index: i }
      : { key: `${first} ${sub}`, index: i + 1 };
  }
  return { key: first, index: i };
}

/** The verb of a podman argv ("container run" counts as "run"), if gated. */
export function podmanLaunchVerb(
  args: readonly string[],
): PodmanLaunchVerb | undefined {
  const { key } = parsePodmanVerb(args);
  return key == null ? undefined : LAUNCH_VERBS[key];
}

// Options allowed between a run/create verb and the policy's user namespace
// flags (the ones the launchers put there): the flags must come before the
// image operand, which only options may precede.
const RUN_PREFIX: OptionSpec = {
  longValue: new Set([
    "--runtime",
    "--name",
    "--label",
    "--cgroups",
    "--security-opt",
    "--cap-drop",
    "--pids-limit",
    "--network",
  ]),
  longBoolean: new Set([
    "--interactive",
    "--detach",
    "--rm",
    "--replace",
    "--tty",
    "--read-only",
  ]),
  shortValue: "",
  shortBoolean: "dit",
};

interface OptionSpec {
  longValue: Set<string>;
  longBoolean: Set<string>;
  shortValue: string;
  shortBoolean: string;
}

/** Whether args[from..to) are options only, by spec (values included). */
function optionsOnly(
  args: readonly string[],
  from: number,
  to: number,
  spec: OptionSpec,
): boolean {
  for (let i = from; i < to; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") || arg === "-" || arg === "--") return false;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0];
      if (spec.longValue.has(name)) {
        if (!arg.includes("=")) i += 1;
      } else if (arg.includes("=") || !spec.longBoolean.has(name)) {
        return false;
      }
    } else {
      const letters = arg.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const c = letters[k];
        if (spec.shortBoolean.includes(c)) continue;
        if (!spec.shortValue.includes(c)) return false;
        if (k === letters.length - 1) i += 1;
        break;
      }
    }
    if (i >= to) return false; // a value can't be the policy's first flag
  }
  return true;
}

// Sharing the host's or another container's pid namespace (or a pod's) would
// put a container's processes where the self-check expects only Podman's own.
const PID_SHARING = /^--(pid|pidns|pod|pod-id-file)(=|$)/;

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

// Options allowed between exec and the policy's user flags (not -u/--user:
// those are the policy's).
const EXEC_PREFIX: OptionSpec = {
  longValue: new Set(
    [...EXEC_LONG_WITH_VALUE].filter((name) => name !== "--user"),
  ),
  longBoolean: EXEC_LONG_BOOLEAN,
  shortValue: "ew",
  shortBoolean: EXEC_SHORT_BOOLEAN,
};

/** The container operand of a podman exec argv, or undefined when it can't
 * be determined exactly. */
export function podmanExecTarget(args: readonly string[]): string | undefined {
  const { key, index, badOption } = parsePodmanVerb(args);
  if (badOption != null || (key !== "exec" && key !== "container exec"))
    return undefined;
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

// every --userns* option (build's --userns-uid-map and friends included)
const USERNS_FLAG =
  /^(--userns[a-z-]*|--uidmap|--gidmap|--user|-u|--subuidname|--subgidname)(=|$)/;

// boolean short options podman run/create/exec accept in a cluster
const SHORT_BOOLEAN = "ditP";

function isUsernsFlag(arg: string): boolean {
  if (USERNS_FLAG.test(arg)) return true;
  // the attached short form: -u0, or -u inside a cluster (-itu0)
  if (!arg.startsWith("-") || arg.startsWith("--")) return false;
  for (const c of arg.slice(1)) {
    if (c === "u") return true;
    if (!SHORT_BOOLEAN.includes(c)) return false; // the rest is a value
  }
  return false;
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
  const parsed = parsePodmanVerb(args);
  if (parsed.badOption != null) {
    throw new PodmanLaunchRefused(
      "global-option",
      `podman: the global option ${parsed.badOption} is not allowed`,
    );
  }
  const verb = parsed.key == null ? undefined : LAUNCH_VERBS[parsed.key];
  if (verb == null) {
    if (parsed.key == null || !NON_LAUNCH_VERBS.has(parsed.key)) {
      throw new PodmanLaunchRefused(
        "verb-not-allowed",
        "podman: this verb is not allowed through the wrappers",
      );
    }
    // unshare's own arguments are the command it runs (as the runtime uid,
    // in Podman's namespace): no container options there
    if (parsed.key !== "unshare" && args.some(isUsernsFlag)) {
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
  if (
    (verb === "run" || verb === "create") &&
    args.some((arg) => PID_SHARING.test(arg))
  ) {
    throw new PodmanLaunchRefused(
      "pid-sharing",
      "podman: a launched container can't share another pid namespace or a pod",
    );
  }
  // The policy's flags come before the first operand (the image, or the
  // exec's container): only options may stand between the verb and them.
  if (expected.length > 0) {
    const start = indexOfSequence(args, expected);
    const spec =
      verb === "exec" ? EXEC_PREFIX : verb === "build" ? undefined : RUN_PREFIX;
    if (spec == null || !optionsOnly(args, parsed.index + 1, start, spec)) {
      throw new PodmanLaunchRefused(
        "userns-placement",
        "podman: the launch policy's user namespace flags must come before the image or container",
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
  // where rootless podman looks for containers.conf and storage
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // a remote podman service instead of the local one
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
];
